import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  SharedFields,
  InvalidSharedUpdate,
  encodeUpdate,
} from "./sharedFields";
import type { EditorField } from "../canvas/types";
import type { GaebContentFacet } from "./contentFacets";

const TEXT = "item-a:text:0";
const INVOICE = "meta:invoice-date";

function fields(editable = true): Map<string, EditorField> {
  return new Map([
    [
      TEXT,
      {
        key: TEXT,
        facet: "scope",
        value: "Text",
        multiline: true,
        editable,
        label: "Beschreibung",
        commit() {},
      },
    ],
    [
      INVOICE,
      {
        key: INVOICE,
        facet: "billing",
        value: "Rechnung",
        multiline: false,
        editable,
        label: "Rechnungsdatum",
        commit() {},
      },
    ],
  ]);
}

function initializer(key: string, value: string, identity = 17) {
  const document = new Y.Doc();
  try {
    // Equal Yjs identities in different encrypted facets must stay independent.
    document.clientID = identity;
    document.getMap("__fields").set(key, true);
    document.getText(key).insert(0, value);
    return encodeUpdate(Y.encodeStateAsUpdate(document));
  } finally {
    document.destroy();
  }
}

function peer(editable = true) {
  const state = new SharedFields();
  state.enableFacets();
  state.register(fields(editable));
  return state;
}

function initialize(state: SharedFields) {
  state.receiveInitialization(TEXT, "Text", initializer(TEXT, "Text"), "scope");
  state.receiveInitialization(
    INVOICE,
    "Rechnung",
    initializer(INVOICE, "Rechnung"),
    "billing",
  );
}

test("independent facet connections keep their own write rights and survive another channel disconnecting", () => {
  const state = peer();
  const textMessages: Record<string, unknown>[] = [];
  const billingMessages: Record<string, unknown>[] = [];
  try {
    initialize(state);
    state.connectFacet(
      "scope",
      (message) => textMessages.push(message),
      true,
      "text-connection",
    );
    state.connectFacet(
      "billing",
      (message) => billingMessages.push(message),
      false,
      "billing-connection",
    );
    textMessages.length = 0;
    billingMessages.length = 0;
    state.edit(INVOICE, "Rechnung", "Unzulässige Änderung");
    assert.equal(state.value(INVOICE), "Rechnung");
    assert.equal(billingMessages.length, 0);
    state.edit(TEXT, "Text", "Textänderung");
    assert.ok(textMessages.some((message) => message.type === "update"));
    state.disconnectFacet("billing");
    textMessages.length = 0;
    state.edit(TEXT, "Textänderung", "Weitere Textänderung");
    assert.ok(textMessages.some((message) => message.type === "update"));
    assert.equal(billingMessages.length, 0);
  } finally {
    state.destroy();
  }
});

test("equal CRDT identities in different facets retain separate texts and wire states", () => {
  const state = peer();
  const updates: Record<string, unknown>[] = [];
  try {
    initialize(state);
    assert.equal(state.value(TEXT), "Text");
    assert.equal(state.value(INVOICE), "Rechnung");
    state.connect((message) => updates.push(message), true);
    assert.equal(updates.length, 2);
    for (const update of updates) {
      const receiver = peer(false);
      try {
        receiver.receive(String(update.data), update.facet as GaebContentFacet);
        if (update.facet === "scope") {
          assert.equal(receiver.value(TEXT), "Text");
          assert.equal(receiver.value(INVOICE), undefined);
        } else {
          assert.equal(receiver.value(TEXT), undefined);
          assert.equal(receiver.value(INVOICE), "Rechnung");
        }
      } finally {
        receiver.destroy();
      }
    }
  } finally {
    state.destroy();
  }
});

test("a scope packet cannot initialize or change a registered billing field", () => {
  const reader = peer();
  try {
    assert.throws(
      () =>
        reader.receiveInitialization(
          INVOICE,
          "Rechnung",
          initializer(INVOICE, "Rechnung"),
          "scope",
        ),
      InvalidSharedUpdate,
    );
    assert.throws(
      () => reader.receive(initializer(INVOICE, "Rechnung"), "scope"),
      InvalidSharedUpdate,
    );
    assert.equal(reader.value(INVOICE), undefined);
    initialize(reader);
    assert.equal(reader.value(INVOICE), "Rechnung");
    assert.equal(reader.value(TEXT), "Text");
  } finally {
    reader.destroy();
  }
});

test("staging two facets changes neither until commit and listeners see the whole accepted batch", () => {
  const writer = peer();
  const reader = peer(false);
  const updates: Record<string, unknown>[] = [];
  const observed: Array<[string, string | undefined, string | undefined]> = [];
  try {
    initialize(writer);
    initialize(reader);
    writer.connect((message) => updates.push(message), true);
    updates.length = 0;
    writer.edit(TEXT, "Text", "Text neu");
    writer.edit(INVOICE, "Rechnung", "Rechnung neu");
    reader.subscribe(({ key }) =>
      observed.push([key, reader.value(TEXT), reader.value(INVOICE)]),
    );
    const reception = reader.beginReceive();
    for (const update of updates) {
      reception.update(String(update.data), update.facet as GaebContentFacet);
    }
    assert.equal(reader.value(TEXT), "Text");
    assert.equal(reader.value(INVOICE), "Rechnung");
    assert.equal(observed.length, 0);
    reception.commit();
    assert.equal(observed.length, 2);
    assert.ok(
      observed.every(
        ([, text, invoice]) =>
          text === "Text neu" && invoice === "Rechnung neu",
      ),
    );
  } finally {
    writer.destroy();
    reader.destroy();
  }
});

test("a discarded multi-facet page leaves every initializer and baseline uncommitted", () => {
  const reader = peer();
  try {
    const reception = reader.beginReceive();
    reception.initialize(TEXT, "Text", initializer(TEXT, "Text"), "scope");
    reception.initialize(
      INVOICE,
      "Rechnung",
      initializer(INVOICE, "Rechnung"),
      "billing",
    );
    reception.destroy();
    assert.equal(reader.value(TEXT), undefined);
    assert.equal(reader.value(INVOICE), undefined);
    initialize(reader);
    assert.equal(reader.value(TEXT), "Text");
    assert.equal(reader.value(INVOICE), "Rechnung");
  } finally {
    reader.destroy();
  }
});

test("undo and redo follow local edit order across independent facet histories", () => {
  const state = peer();
  try {
    initialize(state);
    state.connect(() => {}, true);
    state.edit(TEXT, "Text", "Text 1");
    state.edit(INVOICE, "Rechnung", "Rechnung 1");
    state.edit(TEXT, "Text 1", "Text 12");
    state.undo("undo");
    assert.equal(state.value(TEXT), "Text 1");
    state.undo("undo");
    assert.equal(state.value(INVOICE), "Rechnung");
    state.undo("undo");
    assert.equal(state.value(TEXT), "Text");
    state.undo("redo");
    assert.equal(state.value(TEXT), "Text 1");
    state.undo("redo");
    assert.equal(state.value(INVOICE), "Rechnung 1");
    state.undo("redo");
    assert.equal(state.value(TEXT), "Text 12");
  } finally {
    state.destroy();
  }
});

test("enabling facets preserves queued offline drafts without transferring another field's CRDT", () => {
  const state = new SharedFields();
  try {
    state.register(fields());
    state.edit(INVOICE, "Rechnung", "Rechnung lokal");
    state.enableFacets();
    initialize(state);
    assert.equal(state.value(INVOICE), "Rechnung lokal");
    assert.equal(state.value(TEXT), "Text");
  } finally {
    state.destroy();
  }
});

test("read-only fields neither initialize nor edit locally and write revocation clears undo", () => {
  const state = peer(false);
  const sent: unknown[] = [];
  try {
    state.connect((message) => sent.push(message), true);
    state.edit(INVOICE, "Rechnung", "Verboten");
    assert.deepEqual(sent, []);
    initialize(state);
    assert.equal(state.value(INVOICE), "Rechnung");
    state.register(fields());
    state.edit(INVOICE, "Rechnung", "Rechnung neu");
    assert.equal(state.canUndo("undo"), true);
    state.register(fields(false));
    assert.equal(state.canUndo("undo"), false);
  } finally {
    state.destroy();
  }
});

test("a field learned after an unknown initializer belongs only to its registered facet", () => {
  const state = new SharedFields();
  try {
    state.enableFacets();
    state.receiveInitialization(
      INVOICE,
      "Öffentlicher Köder",
      initializer(INVOICE, "Öffentlicher Köder", 18),
      "scope",
    );
    state.register(fields());
    assert.equal(state.value(INVOICE), undefined);
    state.receiveInitialization(
      INVOICE,
      "Rechnung",
      initializer(INVOICE, "Rechnung"),
      "billing",
    );
    state.receiveInitialization(
      TEXT,
      "Text",
      initializer(TEXT, "Text"),
      "scope",
    );
    assert.equal(state.value(INVOICE), "Rechnung");
    assert.equal(state.value(TEXT), "Text");
  } finally {
    state.destroy();
  }
});

test("a prepared page cannot accept later packets before its atomic publication", () => {
  const reader = peer();
  const writer = peer();
  const updates: Record<string, unknown>[] = [];
  try {
    initialize(reader);
    initialize(writer);
    reader.connect(() => {}, true);
    writer.connect((message) => updates.push(message), true);
    updates.length = 0;
    writer.edit(TEXT, "Text", "Text neu");
    writer.edit(INVOICE, "Rechnung", "Rechnung neu");
    const reception = reader.beginReceive();
    try {
      for (const update of updates) {
        reception.update(String(update.data), update.facet as GaebContentFacet);
      }
      const publish = reception.prepare();
      assert.throws(
        () =>
          reception.initialize(
            "meta:other",
            "Später",
            initializer("meta:other", "Später", 18),
            "scope",
          ),
        InvalidSharedUpdate,
      );
      assert.equal(reader.value(TEXT), "Text");
      assert.equal(reader.value(INVOICE), "Rechnung");
      publish();
      assert.equal(reader.value(TEXT), "Text neu");
      assert.equal(reader.value(INVOICE), "Rechnung neu");
    } finally {
      reception.destroy();
    }
  } finally {
    reader.destroy();
    writer.destroy();
  }
});

test("a read-only connection cannot edit an otherwise writable registered field", () => {
  const state = peer();
  const sent: unknown[] = [];
  try {
    initialize(state);
    state.connect((message) => sent.push(message), false);
    state.edit(TEXT, "Text", "Nicht erlaubt");
    state.edit(INVOICE, "Rechnung", "Nicht erlaubt");
    assert.equal(state.value(TEXT), "Text");
    assert.equal(state.value(INVOICE), "Rechnung");
    assert.equal(sent.length, 0);
  } finally {
    state.destroy();
  }
});

test("destroyed handles cannot return private field text or accept a replacement document", () => {
  for (const faceted of [false, true]) {
    const state = new SharedFields();
    if (faceted) {
      state.enableFacets();
    }
    state.register(fields());
    state.receiveInitialization(
      TEXT,
      "Text",
      initializer(TEXT, "Text"),
      "scope",
    );
    state.destroy();
    assert.throws(() => state.value(TEXT), InvalidSharedUpdate);
    assert.throws(
      () => state.acknowledge("invalid", "private.x89"),
      InvalidSharedUpdate,
    );
    assert.throws(
      () => state.project("invalid", "private.x89"),
      InvalidSharedUpdate,
    );
  }
});
