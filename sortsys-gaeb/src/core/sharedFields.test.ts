import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  SharedFields,
  InvalidSharedUpdate,
  initializeSharedField,
  decodeUpdate,
  encodeUpdate,
} from "./sharedFields";
import type { EditorField } from "../canvas/types";

function room() {
  const state = new Y.Doc();
  const peers: SharedFields[] = [];
  const pending: Array<() => void> = [];
  let held = false;
  const broadcast = (update: Uint8Array) =>
    peers.forEach((peer) => peer.receive(encodeUpdate(update)));
  return {
    add(initial = "Hallo Welt") {
      const peer = new SharedFields();
      peer.register(
        new Map([
          [
            "item-a:text:0",
            {
              key: "item-a:text:0",
              value: initial,
              multiline: true,
              editable: true,
              label: "Text",
              commit() {},
            } satisfies EditorField,
          ],
        ]),
      );
      peers.push(peer);
      peer.receive(encodeUpdate(Y.encodeStateAsUpdate(state)));
      peer.connect((message) => {
        const apply = () => {
          if (message.type === "initialize") {
            const key = String(message.key);
            const fields = state.getMap("__fields");
            if (fields.has(key)) {
              return;
            }
            state.transact(() => {
              fields.set(key, true);
              state.getText(key).insert(0, String(message.value));
            });
            broadcast(Y.encodeStateAsUpdate(state));
          } else if (message.type === "update") {
            const update = decodeUpdate(String(message.data));
            Y.applyUpdate(state, update);
            broadcast(update);
          }
        };
        if (held) {
          pending.push(apply);
        } else {
          apply();
        }
      }, true);
      return peer;
    },
    hold() {
      held = true;
    },
    flush() {
      held = false;
      pending.splice(0).forEach((apply) => apply());
    },
  };
}

test("live text converges for simultaneous insertions at the same position, including emoji", () => {
  const session = room();
  const first = session.add();
  const second = session.add();
  session.hold();
  first.edit("item-a:text:0", "Hallo Welt", "Hallo 👋 Welt");
  second.edit("item-a:text:0", "Hallo Welt", "Hallo schöne Welt");
  session.flush();
  assert.equal(first.value("item-a:text:0"), second.value("item-a:text:0"));
  assert.ok(first.value("item-a:text:0")?.includes("👋 "));
  assert.ok(first.value("item-a:text:0")?.includes("schöne "));
  assert.equal(first.value("item-a:text:0")?.match(/Hallo/g)?.length, 1);
});

test("an invalid embedded CRDT object cannot mutate the live text or prevent a later valid edit", () => {
  const session = room();
  const reader = session.add();
  const writer = session.add();
  const hostile = new Y.Doc();
  try {
    hostile.getText("item-a:text:0").insertEmbed(0, { unexpected: "object" });
    assert.throws(() =>
      reader.receive(encodeUpdate(Y.encodeStateAsUpdate(hostile))),
    );
    assert.equal(reader.value("item-a:text:0"), "Hallo Welt");
    writer.edit("item-a:text:0", "Hallo Welt", "Hallo Baustelle");
    assert.equal(reader.value("item-a:text:0"), "Hallo Baustelle");
  } finally {
    hostile.destroy();
  }
});

function fieldReader(value = "Hallo Welt") {
  const reader = new SharedFields();
  reader.register(
    new Map([
      [
        "item-a:text:0",
        {
          key: "item-a:text:0",
          value,
          multiline: true,
          editable: true,
          label: "Text",
          commit() {},
        } satisfies EditorField,
      ],
    ]),
  );
  return reader;
}

test("discarding a staged initializer retains the old baseline and queued local input", () => {
  const key = "item-a:text:0";
  const reader = fieldReader();
  try {
    reader.edit(key, "Hallo Welt", "Hallo schöne Welt");
    const reception = reader.beginReceive();
    reception.initialize(
      key,
      "Unbestätigte Grundlage",
      initializeSharedField(key, "Unbestätigte Grundlage"),
    );
    reception.destroy();
    assert.equal(reader.value(key), undefined);
    assert.equal(
      reader.receiveInitialization(
        key,
        "Hallo Welt",
        initializeSharedField(key, "Hallo Welt"),
      ),
      true,
    );
    assert.equal(reader.value(key), "Hallo schöne Welt");
  } finally {
    reader.destroy();
  }
});

test("typing into a published snapshot before replay uses that snapshot as its edit baseline", () => {
  const key = "item-a:text:0";
  const original = "Ursprüngliches Bauvorhaben";
  const published = "Gemeinsames Auftrags-LV von John und Frank";
  const replacement = "Nach dem Entzug ausschließlich für John";
  const initial = initializeSharedField(key, original);
  const reader = fieldReader(published);
  const writer = new Y.Doc();
  const reception = reader.beginReceive();
  try {
    reader.edit(key, published, replacement);
    Y.applyUpdate(writer, decodeUpdate(initial));
    writer.transact(() => {
      const field = writer.getText(key);
      field.delete(0, field.length);
      field.insert(0, published);
    });
    reception.initialize(key, original, initial);
    reception.update(encodeUpdate(Y.encodeStateAsUpdate(writer)));
    reception.commit();
    assert.equal(reader.value(key), replacement);
  } finally {
    reception.destroy();
    reader.destroy();
    writer.destroy();
  }
});

test("only the first complete valid initializer wins and cannot smuggle another field", () => {
  const key = "item-a:text:0";
  const reader = fieldReader();
  try {
    assert.throws(
      () =>
        reader.receiveInitialization(
          key,
          "Andere Grundlage",
          initializeSharedField(key, "Hallo Welt"),
        ),
      InvalidSharedUpdate,
    );
    assert.throws(
      () =>
        reader.receiveInitialization(
          key,
          "Hallo Welt",
          initializeSharedField("anderes-feld", "Hallo Welt"),
        ),
      InvalidSharedUpdate,
    );
    assert.equal(reader.value(key), undefined);
    assert.equal(
      reader.receiveInitialization(
        key,
        "Hallo Welt",
        initializeSharedField(key, "Hallo Welt"),
      ),
      true,
    );
    assert.equal(
      reader.receiveInitialization(
        key,
        "Zweite Grundlage",
        initializeSharedField(key, "Zweite Grundlage"),
      ),
      false,
    );
    assert.equal(reader.value(key), "Hallo Welt");
  } finally {
    reader.destroy();
  }
});

test("a rejected update cannot poison staged valid edits and listeners see only their committed result", () => {
  const key = "item-a:text:0";
  const initial = initializeSharedField(key, "Hallo Welt");
  const reader = fieldReader();
  const writer = new Y.Doc();
  const hostile = new Y.Doc();
  const reception = reader.beginReceive();
  const changes: string[] = [];
  reader.subscribe((change) => changes.push(change.value));
  try {
    reception.initialize(key, "Hallo Welt", initial);
    Y.applyUpdate(writer, decodeUpdate(initial));
    writer.getText(key).insert(6, "schöne ");
    reception.update(encodeUpdate(Y.encodeStateAsUpdate(writer)));
    hostile.getMap("__fields").set(key, true);
    hostile.getText(key).insertEmbed(0, { unsafe: "object" });
    assert.throws(
      () => reception.update(encodeUpdate(Y.encodeStateAsUpdate(hostile))),
      InvalidSharedUpdate,
    );
    writer.getText(key).insert(writer.getText(key).length, "!");
    reception.update(encodeUpdate(Y.encodeStateAsUpdate(writer)));
    assert.equal(reader.value(key), undefined);
    assert.deepEqual(changes, []);
    reception.commit();
    assert.equal(reader.value(key), "Hallo schöne Welt!");
    assert.deepEqual(changes, ["Hallo schöne Welt!"]);
  } finally {
    reception.destroy();
    reader.destroy();
    writer.destroy();
    hostile.destroy();
  }
});

test("committing a network batch preserves local typing performed after the batch began", () => {
  const key = "item-a:text:0";
  const initial = initializeSharedField(key, "Hallo Welt");
  const reader = fieldReader();
  const writer = new Y.Doc();
  reader.receiveInitialization(key, "Hallo Welt", initial);
  reader.connect(() => {}, true);
  const reception = reader.beginReceive();
  try {
    Y.applyUpdate(writer, decodeUpdate(initial));
    writer.getText(key).insert(6, "schöne ");
    reception.update(encodeUpdate(Y.encodeStateAsUpdate(writer)));
    reader.edit(key, "Hallo Welt", "Hallo Welt!");
    reception.commit();
    assert.equal(reader.value(key), "Hallo schöne Welt!");
  } finally {
    reception.destroy();
    reader.destroy();
    writer.destroy();
  }
});

test("updates with unresolved dependencies leave no hidden pending structs in the editor", () => {
  const key = "item-a:text:0";
  const initial = initializeSharedField(key, "Hallo Welt");
  const writer = new Y.Doc();
  const reader = fieldReader();
  try {
    Y.applyUpdate(writer, decodeUpdate(initial));
    const vector = Y.encodeStateVector(writer);
    writer.getText(key).insert(6, "schöne ");
    const update = encodeUpdate(Y.encodeStateAsUpdate(writer, vector));
    assert.throws(() => reader.receive(update), InvalidSharedUpdate);
    assert.equal(reader.value(key), undefined);
    reader.receiveInitialization(key, "Hallo Welt", initial);
    assert.equal(reader.value(key), "Hallo Welt");
    reader.receive(update);
    assert.equal(reader.value(key), "Hallo schöne Welt");
  } finally {
    reader.destroy();
    writer.destroy();
  }
});

test("empty field markers cannot bypass the shared document size limit", () => {
  const reader = fieldReader();
  const hostile = new Y.Doc();
  try {
    hostile.transact(() => {
      const fields = hostile.getMap("__fields");
      for (let index = 0; index < 25_001; index += 1) {
        fields.set(`empty-field-${index}`, true);
      }
    });
    assert.throws(
      () => reader.receive(encodeUpdate(Y.encodeStateAsUpdate(hostile))),
      InvalidSharedUpdate,
    );
    assert.equal(reader.value("item-a:text:0"), undefined);
    reader.receiveInitialization(
      "item-a:text:0",
      "Hallo Welt",
      initializeSharedField("item-a:text:0", "Hallo Welt"),
    );
    assert.equal(reader.value("item-a:text:0"), "Hallo Welt");
  } finally {
    hostile.destroy();
    reader.destroy();
  }
});

test("remote insertions keep the local caret attached to its text", () => {
  const session = room();
  const first = session.add();
  const second = session.add();
  first.cursor({ field: "item-a:text:0", start: 6, end: 10 });
  const changes: Array<{ start?: number; end?: number }> = [];
  first.subscribe((change) => {
    if (change.selection) {
      changes.push(change.selection);
    }
  });
  second.edit("item-a:text:0", "Hallo Welt", "Hallo schöne Welt");
  assert.equal(changes.at(-1)?.start, 13);
  assert.equal(changes.at(-1)?.end, 17);
});

test("empty text fields initialize once and simultaneous deletions do not duplicate surviving text", () => {
  const session = room();
  const first = session.add("");
  const second = session.add("");
  assert.equal(first.value("item-a:text:0"), "");
  first.edit("item-a:text:0", "", "ABCDE");
  session.hold();
  first.edit("item-a:text:0", "ABCDE", "ABE");
  second.edit("item-a:text:0", "ABCDE", "ACDE");
  session.flush();
  assert.equal(first.value("item-a:text:0"), "AE");
  assert.equal(second.value("item-a:text:0"), "AE");
});

test("Undo removes only this user's live insertion and preserves the other user's text", () => {
  const session = room();
  const first = session.add();
  const second = session.add();
  session.hold();
  first.edit("item-a:text:0", "Hallo Welt", "Hallo A Welt");
  second.edit("item-a:text:0", "Hallo Welt", "Hallo B Welt");
  session.flush();
  first.undo("undo");
  assert.equal(first.value("item-a:text:0"), "Hallo B Welt");
  assert.equal(second.value("item-a:text:0"), "Hallo B Welt");
  first.undo("redo");
  assert.equal(first.value("item-a:text:0"), second.value("item-a:text:0"));
  assert.ok(first.value("item-a:text:0")?.includes("A "));
  assert.ok(first.value("item-a:text:0")?.includes("B "));
});

test("a new session discards old CRDT IDs while retaining unsaved text and avoiding an already saved insertion twice", () => {
  const key = "item-a:text:0";
  const peer = new SharedFields();
  peer.register(
    new Map([
      [
        key,
        {
          key,
          value: "Hallo Welt",
          multiline: true,
          editable: true,
          label: "Text",
          commit() {},
        } satisfies EditorField,
      ],
    ]),
  );
  let server = new Y.Doc();
  const sent: string[] = [];
  const send = (message: Record<string, unknown>) => {
    sent.push(String(message.type));
    if (message.type === "initialize") {
      if (!server.getMap("__fields").has(key)) {
        server.transact(() => {
          server.getMap("__fields").set(key, true);
          server.getText(key).insert(0, String(message.value));
        });
      }
    } else {
      Y.applyUpdate(server, decodeUpdate(String(message.data)));
    }
    peer.receive(encodeUpdate(Y.encodeStateAsUpdate(server)));
  };
  peer.connect(send, true, "1");
  peer.edit(key, "Hallo Welt", "Hallo offline Welt");
  peer.disconnect();
  server.destroy();
  server = new Y.Doc();
  // A different browser has already initialized the current native file.
  server.transact(() => {
    server.getMap("__fields").set(key, true);
    server.getText(key).insert(0, "Hallo offline Welt");
  });
  sent.length = 0;
  peer.connect(send, true, "2");
  assert.equal(sent[0], "initialize");
  assert.equal(peer.value(key), "Hallo offline Welt");
  assert.equal(server.getText(key).toString(), "Hallo offline Welt");
  // Drafts which have not reached the native file are reapplied once as text.
  peer.edit(key, "Hallo offline Welt", "Hallo offline Welt!");
  peer.disconnect();
  server.destroy();
  server = new Y.Doc();
  peer.connect(send, true, "3");
  assert.equal(peer.value(key), "Hallo offline Welt!");
  assert.equal(server.getText(key).toString(), "Hallo offline Welt!");
  // Rejoining the same session retains CRDT identities and remains idempotent.
  peer.disconnect();
  sent.length = 0;
  peer.connect(send, true, "3");
  assert.equal(sent[0], "update");
  assert.equal(server.getText(key).toString(), "Hallo offline Welt!");
  peer.destroy();
  server.destroy();
});
