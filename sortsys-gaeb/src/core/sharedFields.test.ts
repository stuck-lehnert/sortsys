import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { SharedFields, decodeUpdate, encodeUpdate } from "./sharedFields";
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
            const key = String(message.key),
              fields = state.getMap("__fields");
            if (fields.has(key)) return;
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
        if (held) pending.push(apply);
        else apply();
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
  const session = room(),
    first = session.add(),
    second = session.add();
  session.hold();
  first.edit("item-a:text:0", "Hallo Welt", "Hallo 👋 Welt");
  second.edit("item-a:text:0", "Hallo Welt", "Hallo schöne Welt");
  session.flush();
  assert.equal(first.value("item-a:text:0"), second.value("item-a:text:0"));
  assert.ok(first.value("item-a:text:0")?.includes("👋 "));
  assert.ok(first.value("item-a:text:0")?.includes("schöne "));
  assert.equal(first.value("item-a:text:0")?.match(/Hallo/g)?.length, 1);
});

test("remote insertions keep the local caret attached to its text", () => {
  const session = room(),
    first = session.add(),
    second = session.add();
  first.cursor({ field: "item-a:text:0", start: 6, end: 10 });
  const changes: Array<{ start?: number; end?: number }> = [];
  first.subscribe((change) => {
    if (change.selection) changes.push(change.selection);
  });
  second.edit("item-a:text:0", "Hallo Welt", "Hallo schöne Welt");
  assert.equal(changes.at(-1)?.start, 13);
  assert.equal(changes.at(-1)?.end, 17);
});

test("empty text fields initialize once and simultaneous deletions do not duplicate surviving text", () => {
  const session = room(),
    first = session.add(""),
    second = session.add("");
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
  const session = room(),
    first = session.add(),
    second = session.add();
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
      if (!server.getMap("__fields").has(key))
        server.transact(() => {
          server.getMap("__fields").set(key, true);
          server.getText(key).insert(0, String(message.value));
        });
    } else Y.applyUpdate(server, decodeUpdate(String(message.data)));
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
