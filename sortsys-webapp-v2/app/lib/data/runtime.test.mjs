import { duckDriver as driver } from "./testing/duckDriver.mjs";
import { expect, test } from "bun:test";
import {
  InvalidProtectedData,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { DataRuntime } from "./runtime/runtime";
import { defineDataModel, UNLOADED } from "./runtime/model";
import { decodeBusinessRow } from "./rowCodec";
import { row } from "./rowCodec.test.mjs";
import { ProtectedWriteConflict } from "./atomicWrites";
import { COMMERCIAL_FACETS } from "./commercialAreas";
import { splitCommercialRows } from "./commercialData";
import { commercialRequest, workflowReceiptRequest } from "./commercialModel";
import { toolPart, toolRequest } from "./toolData";
import { PRINT_OBJECT, printTemplatePayload } from "./printTemplateData";
import { PRINT_COLLECTION } from "./organizationData";

const mainArea = {
  domain: "test:master-data",
  scope: "test",
  facet: "master-data",
  prefix: "main:",
};
const privateArea = {
  domain: "test:procurement",
  scope: "test",
  facet: "procurement",
  prefix: "private:",
};
const main = defineDataModel({
  name: "main",
  decode: (value) => ({ row: decodeBusinessRow(value.row) }),
  exclude: { product_price_records: ["price"] },
  externalReferences: ["products", "product_vendors"],
});
const prices = defineDataModel({
  name: "private",
  decode: (value) => value,
  sources: (value) => [
    {
      table: "product_price_records",
      kind: "fragment",
      values: { id: value.id, price: value.price },
      fields: { price: { path: ["price"] } },
    },
  ],
});
const first = { model: main, area: mainArea };
const second = { model: prices, area: privateArea };

function fixture(lateDriver = false) {
  const states = new Map();
  const calls = { read: 0, selected: 0, commit: 0, drivers: 0 };
  const packets = [];
  let signature = 0;
  let rejectCommit = false;
  let loseReply = false;
  let contextValid = true;
  let deleteAllowed = false;
  const denied = new Set();
  const forbiddenActions = new Set();
  const state = (area) => {
    let value = states.get(area.domain);
    if (!value) {
      value = { sequence: 0, objects: new Map() };
      states.set(area.domain, value);
    }
    return value;
  };
  function seed(area, id, value) {
    const current = state(area);
    const old = current.objects.get(id);
    current.objects.set(id, {
      envelope: {
        object: id,
        revision: String(Number(old?.envelope.revision ?? 0) + 1),
        signature: String(++signature),
      },
      value: structuredClone(value),
    });
    current.sequence++;
  }
  const storage = {
    async open() {
      const open = (area) => {
        if (denied.has(area.domain)) throw new InvalidProtectedData();
        const current = state(area);
        let head = null;
        const collection = {
          async read() {
            calls.read++;
            head = String(current.sequence);
            return [...current.objects.values()]
              .filter(
                (object) =>
                  object.envelope.object.startsWith(area.prefix) &&
                  object.envelope.format !== TOMBSTONE_FORMAT,
              )
              .map((object) => structuredClone(object));
          },
          async inspect(expected) {
            if (expected !== undefined && expected !== String(current.sequence))
              throw new ProtectedWriteConflict();
            head = String(current.sequence);
            return head;
          },
          async selected(ids) {
            calls.selected += ids.length;
            return ids.flatMap((id) =>
              current.objects.has(id) &&
              current.objects.get(id).envelope.format !== TOMBSTONE_FORMAT
                ? [structuredClone(current.objects.get(id))]
                : [],
            );
          },
          async readIfChanged(previous) {
            head = String(current.sequence);
            return previous === head ? null : collection.read();
          },
          can(action) {
            return (
              (action !== "delete" || deleteAllowed) &&
              !forbiddenActions.has(`${area.domain}:${action}`)
            );
          },
          snapshot() {
            if (head === null) throw new Error("Unread");
            return head;
          },
          async get(id) {
            if (!current.objects.has(id)) throw new Error("Missing");
            return structuredClone(current.objects.get(id));
          },
          async packet(id, value, previous) {
            if (!collection.can(previous ? "update" : "create"))
              throw new InvalidProtectedData();
            return {
              domain: area.domain,
              envelope: {
                object: id,
                revision: String(Number(previous?.revision ?? 0) + 1),
                signature: String(++signature),
              },
              value: structuredClone(value),
            };
          },
          async tombstone(id, previous) {
            if (!collection.can("delete") || !previous)
              throw new InvalidProtectedData();
            return {
              domain: area.domain,
              envelope: {
                format: TOMBSTONE_FORMAT,
                object: id,
                revision: String(Number(previous.revision) + 1),
                signature: String(++signature),
              },
              value: null,
            };
          },
          async remove(id) {
            current.objects.delete(id);
            current.sequence++;
          },
          close() {},
        };
        return collection;
      };
      return Object.assign(open, {
        readable: (area) => !denied.has(area.domain),
      });
    },
    async commit(groups, guards) {
      calls.commit++;
      for (const head of [...groups.map((group) => group.head), ...guards])
        if (String(states.get(head.domain).sequence) !== head.sequence)
          throw new ProtectedWriteConflict();
      if (rejectCommit) throw new ProtectedWriteConflict();
      for (const group of groups) {
        const current = states.get(group.head.domain);
        for (const packet of group.packets) {
          current.objects.set(packet.envelope.object, {
            envelope: packet.envelope,
            value: packet.value,
          });
          packets.push(packet);
        }
        current.sequence++;
      }
      // The production storage port verifies even if the HTTP reply was lost.
      const error = loseReply
        ? new Error("Connection lost after commit")
        : null;
      for (const group of groups)
        if (!(await group.verify()))
          throw error ?? new ProtectedWriteConflict();
    },
  };
  const driverFactory = async () => {
    calls.drivers++;
    return driver();
  };
  const runtime = new DataRuntime(
    storage,
    () => {
      if (!contextValid) throw new InvalidProtectedData();
    },
    lateDriver ? undefined : driverFactory,
  );
  seed(mainArea, "main:1", {
    row: row("product_price_records", {
      id: "1",
      product_id: "2",
      price: 0,
      comment: "Vorher",
    }),
  });
  seed(privateArea, "private:1", { id: "1", price: 87.654 });
  return {
    runtime,
    storage,
    calls,
    packets,
    seed,
    state,
    driverFactory,
    deny(domain) {
      denied.add(domain);
    },
    forbid(domain, action) {
      forbiddenActions.add(`${domain}:${action}`);
    },
    reject(value) {
      rejectCommit = value;
    },
    lose(value) {
      loseReply = value;
    },
    allowDelete() {
      deleteAllowed = true;
    },
    revoke() {
      contextValid = false;
      runtime.invalidate();
    },
  };
}

test("read-only preparations retain exact source guards for an external signed publication", async () => {
  const f = fixture();
  let prepared;
  try {
    prepared = await f.runtime.prepare([first, second], (tx) =>
      tx.row("product_price_records", { id: "1" }).require("price"),
    );
    expect(prepared.value).toBe(87.654);
    expect(prepared.groups).toEqual([]);
    expect(prepared.guards).toEqual([
      { domain: mainArea.domain, sequence: "1" },
      { domain: privateArea.domain, sequence: "1" },
    ]);
    expect(f.calls.commit).toBe(0);
    f.state(privateArea).sequence++;
    await expect(f.storage.commit([], prepared.guards)).rejects.toBeInstanceOf(
      ProtectedWriteConflict,
    );
  } finally {
    prepared?.close();
    await f.runtime.close();
  }
});

test("shared rows distinguish unavailable fields from NULL and route patches to their owning facet", async () => {
  const f = fixture();
  try {
    await f.runtime.read([first], async (view) => {
      expect(view.row("product_price_records", { id: "1" }).get("price")).toBe(
        UNLOADED,
      );
      expect(
        view.row("product_price_records", { id: "1" }).require("vendor_id"),
      ).toBeNull();
      await expect(
        view.query({ products: ["id"] }, "SELECT count(*) FROM products"),
      ).rejects.toThrow();
      await expect(
        view.query(
          { product_price_records: ["price"] },
          "SELECT price FROM product_price_records",
        ),
      ).rejects.toThrow();
    });
    await expect(
      f.runtime.transaction([first], (tx) =>
        tx.patch("product_price_records", { id: "1" }, { price: 123 }),
      ),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    await f.runtime.read([first, second], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654),
    );
    f.lose(true);
    await f.runtime.transaction([first, second], (tx) => {
      tx.patch(
        "product_price_records",
        { id: "1" },
        { price: 98.765, comment: "Nachher" },
      );
      expect(
        tx.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(98.765);
      expect(tx.documents(first)[0].value.row.values.comment).toBe("Nachher");
    });
    expect(f.packets.map((packet) => packet.domain).sort()).toEqual(
      [mainArea.domain, privateArea.domain].sort(),
    );
    expect(f.state(mainArea).objects.get("main:1").value.row.values.price).toBe(
      0,
    );
    expect(f.state(privateArea).objects.get("private:1").value.price).toBe(
      98.765,
    );
    expect(f.calls.drivers).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("invalid changes never publish and failed publication preserves the last verified view", async () => {
  const f = fixture();
  try {
    await expect(
      f.runtime.transaction([first], (tx) =>
        tx.patch("product_price_records", { id: "1" }, { extraneous: "bad" }),
      ),
    ).rejects.toThrow();
    await expect(
      f.runtime.transaction([first], (tx) =>
        tx.patch(
          "product_price_records",
          { id: "1" },
          { comment: "x".repeat(10000) },
        ),
      ),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    f.reject(true);
    await expect(
      f.runtime.transaction([first], (tx) =>
        tx.patch(
          "product_price_records",
          { id: "1" },
          { comment: "Never committed" },
        ),
      ),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    await f.runtime.read([first], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("comment"),
      ).toBe("Vorher"),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a relation violation and duplicate business key roll back the entire prospective transaction", async () => {
  const f = fixture();
  const catalogue = defineDataModel({
    name: "catalogue",
    decode: (value) => value,
  });
  const request = {
    model: catalogue,
    area: { ...mainArea, prefix: "catalogue:" },
  };
  f.seed(mainArea, "catalogue:2", {
    product: row("products", { id: "2", custom_id: "25" }),
    categories: [
      row("product_categories", { product_id: "2", category: "Putz" }),
    ],
  });
  try {
    await f.runtime.read([request], async (view) =>
      expect(
        (
          await view.query(
            {
              products: ["id", "name"],
              product_categories: ["product_id", "category"],
            },
            "SELECT p.name,c.category FROM products p JOIN product_categories c ON p.id=c.product_id",
          )
        )[0].category,
      ).toBe("Putz"),
    );
    await expect(
      f.runtime.transaction([request], (tx) =>
        tx.edit(request, "catalogue:2", (value) => {
          value.categories[0].values.product_id = "999";
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.runtime.transaction([request], (tx) =>
        tx.create(request, "catalogue:3", {
          product: row("products", { id: "3", custom_id: "25" }),
          categories: [],
        }),
      ),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    await f.runtime.read([request], (view) =>
      expect(view.rows("products").length).toBe(1),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("cache reuse, invalidation and account revocation are common to all model readers", async () => {
  const f = fixture();
  let oldRow;
  try {
    await f.runtime.read([first], (view) => {
      oldRow = view.row("product_price_records", { id: "1" });
    });
    const reads = f.calls.read;
    await f.runtime.read([first], (view) =>
      expect(view.rows("product_price_records").length).toBe(1),
    );
    expect(f.calls.read).toBe(reads);
    f.seed(mainArea, "main:1", {
      row: row("product_price_records", {
        id: "1",
        product_id: "2",
        comment: "Remote",
      }),
    });
    f.runtime.invalidate(new Set([mainArea.domain]));
    expect(() => oldRow.require("comment")).toThrow();
    await f.runtime.read([first], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("comment"),
      ).toBe("Remote"),
    );
    f.revoke();
    await expect(
      f.runtime.read([first], (view) => view.rows("product_price_records")),
    ).rejects.toThrow();
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a tool handover is an ordinary multi-row command with state checks and one atomic publication", async () => {
  const f = fixture();
  const model = defineDataModel({
    name: "tool-workflow",
    decode: (value) => value,
    externalReferences: ["users", "projects"],
  });
  const request = { model, area: { ...mainArea, prefix: "tool:" } };
  f.seed(mainArea, "tool:1", {
    tool: row("tools", { id: "1", custom_id: "1", status: null }),
    trackings: [
      row("tool_trackings", {
        id: "10",
        tool_id: "1",
        responsible_user_id: "2",
        started_at: "2026-11-11T12:00:00Z",
        ended_at: null,
      }),
    ],
    transfers: [
      row("tool_tracking_transfer_requests", {
        id: "20",
        tool_tracking_id: "10",
        status: "open",
        transfer_to_user_id: "3",
        created_by_user_id: "2",
      }),
    ],
  });
  const accept = (tx, actor) => {
    const transfer = tx.row("tool_tracking_transfer_requests", { id: "20" });
    if (
      transfer.require("status") !== "open" ||
      transfer.require("transfer_to_user_id") !== actor
    )
      throw new Error("Transfer is not available to this actor");
    const previous = tx.row("tool_trackings", {
      id: transfer.require("tool_tracking_id"),
    });
    if (previous.require("ended_at") !== null)
      throw new Error("Tracking has already ended");
    tx.patch(
      "tool_trackings",
      { id: "10" },
      { ended_at: "2026-11-11T14:00:00Z", ended_by_user_id: actor },
    );
    tx.patch(
      "tool_tracking_transfer_requests",
      { id: "20" },
      { status: "accepted" },
    );
    tx.edit(request, "tool:1", (value) =>
      value.trackings.push(
        row("tool_trackings", {
          id: "11",
          tool_id: "1",
          responsible_user_id: actor,
          continuation_of: "10",
          started_at: "2026-11-11T14:00:00Z",
        }),
      ),
    );
  };
  try {
    await expect(
      f.runtime.transaction([request], (tx) => accept(tx, "4")),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    await f.runtime.transaction([request], async (tx) => {
      accept(tx, "3");
      const rows = await tx.query(
        { tool_trackings: ["responsible_user_id", "ended_at"] },
        "SELECT responsible_user_id FROM tool_trackings WHERE ended_at IS NULL",
      );
      expect(rows).toEqual([{ responsible_user_id: 3n }]);
    });
    expect(f.calls.commit).toBe(1);
    expect(f.packets.length).toBe(1);
    await expect(
      f.runtime.transaction([request], (tx) => accept(tx, "3")),
    ).rejects.toThrow();
    await expect(
      f.runtime.transaction([request], (tx) =>
        tx.edit(request, "tool:1", (value) =>
          value.trackings.push(
            row("tool_trackings", { id: "12", tool_id: "1" }),
          ),
        ),
      ),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(1);
    await f.runtime.read([request], (view) => {
      expect(
        view
          .row("tool_tracking_transfer_requests", { id: "20" })
          .require("status"),
      ).toBe("accepted");
      expect(view.rows("tool_trackings").length).toBe(2);
    });
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a soft policy refresh removes revoked fragments without rebuilding still-authorized database state", async () => {
  const f = fixture();
  try {
    await f.runtime.read([first, second], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654),
    );
    const reads = f.calls.read;
    f.runtime.invalidate(
      new Set([mainArea.domain, privateArea.domain]),
      new Map([
        [mainArea.domain, String(f.state(mainArea).sequence)],
        [privateArea.domain, String(f.state(privateArea).sequence)],
      ]),
    );
    await f.runtime.read([first, second], (view) =>
      expect(view.rows("product_price_records").length).toBe(1),
    );
    expect(f.calls.read).toBe(reads);
    f.deny(privateArea.domain);
    f.runtime.revalidate();
    await f.runtime.read([first], async (view) => {
      expect(view.row("product_price_records", { id: "1" }).get("price")).toBe(
        UNLOADED,
      );
      await expect(
        view.query(
          { product_price_records: ["price"] },
          "SELECT price FROM product_price_records",
        ),
      ).rejects.toThrow();
    });
    expect(f.calls.drivers).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("form expectations and verified write tokens use actual signed versions rather than a shared cache basis", async () => {
  const f = fixture();
  let original;
  let confirmed;
  let callbacks = 0;
  try {
    await f.runtime.read([first], (view) => {
      original = view.documents(first)[0].signature;
      expect(view.head(first)).toEqual({
        domain: mainArea.domain,
        sequence: String(f.state(mainArea).sequence),
      });
    });
    await expect(
      f.runtime.transaction([first], (tx) => tx.require(first, "delete")),
    ).rejects.toThrow();
    f.lose(true);
    await f.runtime.transaction(
      [first],
      (tx) => {
        tx.require(first, "update");
        tx.expect(first, "main:1", { signature: original });
        tx.patch(
          "product_price_records",
          { id: "1" },
          { comment: "Confirmed form" },
        );
        expect(callbacks).toBe(0);
      },
      {
        verified: (versions) => {
          callbacks++;
          confirmed = versions[0];
        },
      },
    );
    expect(callbacks).toBe(1);
    expect(confirmed).toEqual({
      domain: mainArea.domain,
      id: "main:1",
      revision: "2",
      signature: f.packets[0].envelope.signature,
    });
    await expect(
      f.runtime.transaction([first], (tx) => {
        tx.expect(first, "main:1", { signature: original });
        tx.patch(
          "product_price_records",
          { id: "1" },
          { comment: "Stale form" },
        );
      }),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    expect(f.calls.commit).toBe(1);
    f.reject(true);
    await expect(
      f.runtime.transaction(
        [first],
        (tx) =>
          tx.patch(
            "product_price_records",
            { id: "1" },
            { comment: "Unconfirmed form" },
          ),
        {
          verified: () => {
            callbacks++;
          },
        },
      ),
    ).rejects.toThrow();
    expect(callbacks).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("prepared business commands compose without publishing speculative rows and retain their original CAS guards", async () => {
  const f = fixture();
  let main;
  let price;
  try {
    main = await f.runtime.prepare([first], (tx) => {
      tx.patch(
        "product_price_records",
        { id: "1" },
        { comment: "Composed command" },
      );
      return "main-result";
    });
    price = await f.runtime.prepare([second], (tx) => {
      tx.patch("product_price_records", { id: "1" }, { price: 41.234 });
      return "price-result";
    });
    expect(main.value).toBe("main-result");
    expect(price.value).toBe("price-result");
    expect(f.calls.commit).toBe(0);
    await f.runtime.read([first, second], (view) => {
      expect(
        view.row("product_price_records", { id: "1" }).require("comment"),
      ).toBe("Vorher");
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654);
    });
    await f.storage.commit(
      [...main.groups, ...price.groups],
      [...main.guards, ...price.guards],
    );
    main.close();
    price.close();
    await f.runtime.read([first, second], (view) => {
      expect(
        view.row("product_price_records", { id: "1" }).require("comment"),
      ).toBe("Composed command");
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(41.234);
    });
    main = await f.runtime.prepare([first], (tx) =>
      tx.patch(
        "product_price_records",
        { id: "1" },
        { comment: "Must roll back" },
      ),
    );
    price = await f.runtime.prepare([second], (tx) =>
      tx.patch("product_price_records", { id: "1" }, { price: 999 }),
    );
    f.seed(privateArea, "private:1", { id: "1", price: 42 });
    await expect(
      f.storage.commit(
        [...main.groups, ...price.groups],
        [...main.guards, ...price.guards],
      ),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    expect(
      f.state(mainArea).objects.get("main:1").value.row.values.comment,
    ).toBe("Composed command");
  } finally {
    main?.close();
    price?.close();
    await f.runtime.close();
  }
}, 15000);

test("selected objects share their canonical collection but never masquerade as a complete list", async () => {
  const f = fixture();
  const one = { ...first, ids: ["main:1"] };
  const two = { ...first, ids: ["main:2"] };
  f.seed(mainArea, "main:2", {
    row: row("product_price_records", {
      id: "2",
      product_id: "2",
      comment: "Second",
    }),
  });
  try {
    await f.runtime.read([one], async (view) => {
      expect(view.documents(one).length).toBe(1);
      expect(() => view.documents(first)).toThrow();
      await expect(
        view.query(
          { product_price_records: ["id"] },
          "SELECT count(*) FROM product_price_records",
        ),
      ).rejects.toThrow();
    });
    expect(f.calls.read).toBe(0);
    expect(f.calls.selected).toBe(1);
    await f.runtime.read([one, two], (view) => {
      expect(view.documents(one)[0].value.row.values.id).toBe("1");
      expect(view.documents(two)[0].value.row.values.id).toBe("2");
    });
    expect(f.calls.selected).toBe(2);
    await f.runtime.transaction([two], (tx) =>
      tx.patch(
        "product_price_records",
        { id: "2" },
        { comment: "Updated selected row" },
      ),
    );
    expect(f.calls.read).toBe(0);
    await f.runtime.read([first], (view) =>
      expect(
        view
          .documents(first)
          .map((document) => document.value.row.values.comment)
          .sort(),
      ).toEqual(["Updated selected row", "Vorher"].sort()),
    );
    expect(f.calls.read).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a changed domain head discards older partial objects and full queries load their replacements", async () => {
  const f = fixture();
  const one = { ...first, ids: ["main:1"] };
  const two = { ...first, ids: ["main:2"] };
  try {
    await f.runtime.read([one], (view) =>
      expect(view.documents(one)[0].value.row.values.comment).toBe("Vorher"),
    );
    f.seed(mainArea, "main:1", {
      row: row("product_price_records", {
        id: "1",
        product_id: "2",
        comment: "Remote",
      }),
    });
    f.seed(mainArea, "main:2", {
      row: row("product_price_records", {
        id: "2",
        product_id: "2",
        comment: "New",
      }),
    });
    await f.runtime.read([two], (view) => {
      expect(view.documents(two).length).toBe(1);
      expect(() => view.documents(one)).toThrow();
    });
    await f.runtime.read([first], (view) =>
      expect(
        view
          .documents(first)
          .map((document) => document.value.row.values.comment)
          .sort(),
      ).toEqual(["New", "Remote"]),
    );
    expect(f.calls.read).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("bulk creation stages once and uses the common verified-publication port for large batches", async () => {
  const f = fixture();
  const empty = { ...first, ids: [] };
  let verified = 0;
  f.storage.verifyPublished = async (packets) => {
    verified += packets.length;
    return new Set(
      packets
        .filter(
          (packet) =>
            f.state(mainArea).objects.get(packet.envelope.object)?.envelope
              .signature === packet.envelope.signature,
        )
        .map((packet) => packet.envelope.object),
    );
  };
  try {
    await f.runtime.transaction([empty], (tx) =>
      tx.createMany(
        empty,
        Array.from({ length: 384 }, (_, index) => ({
          id: `main:${index + 2}`,
          value: {
            row: row("product_price_records", {
              id: String(index + 2),
              product_id: "2",
              comment: `Bulk ${index}`,
            }),
          },
        })),
      ),
    );
    expect(f.calls.read).toBe(0);
    expect(f.calls.selected).toBe(0);
    expect(f.calls.commit).toBe(1);
    expect(verified).toBe(384);
    await f.runtime.read([first], (view) =>
      expect(view.documents(first).length).toBe(385),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);

function commercialFixture(f) {
  const source = [
    row("commercial_cases", {
      id: "100",
      reference: "ANG-1",
      title: "Fenstersanierung",
      kind: "offer",
      status: "draft",
      scope_item_ids: '["window-1"]',
      notes: "Private Kalkulation",
      net_amount: "1234.56",
    }),
    row("commercial_documents", {
      id: "101",
      case_id: "100",
      purpose: "offer",
      phase: "84",
      file_name: "Fenstersanierung.x84",
      object_key: "private-storage-key",
      net_amount: "1234.56",
    }),
  ];
  const parts = splitCommercialRows("34", source);
  const requests = COMMERCIAL_FACETS.map((facet) =>
    commercialRequest("34", facet),
  );
  for (const request of requests)
    f.seed(request.area, request.area.prefix, parts.get(request.area.facet));
  // A malformed document blob must never enter a header list or SQL projection.
  f.seed(requests[0].area, "commercial:34:master-data:blob:unrelated", {
    not: "a commercial header",
  });
  return {
    requests,
    master: requests.find((request) => request.area.facet === "master-data"),
    prices: requests.find((request) => request.area.facet === "offer-prices"),
  };
}

test("commercial aggregates use shared rows without loading XML or overwriting inaccessible fields", async () => {
  const f = fixture();
  const { master, prices } = commercialFixture(f);
  try {
    await f.runtime.read([master], async (view) => {
      expect(view.documents(master).length).toBe(1);
      expect(
        view.row("commercial_cases", { id: "100" }).get("net_amount"),
      ).toBe(UNLOADED);
      expect(view.row("commercial_cases", { id: "100" }).get("notes")).toBe(
        UNLOADED,
      );
      expect(view.can(master, "update")).toBe(true);
      expect(view.can(master, "delete")).toBe(false);
      await expect(
        view.query(
          { commercial_invoice_payments: ["id"] },
          "SELECT count(*) FROM commercial_invoice_payments",
        ),
      ).rejects.toThrow();
    });
    await f.runtime.transaction([master], (tx) =>
      tx.patch(
        "commercial_cases",
        { id: "100" },
        { title: "Neue Bezeichnung" },
      ),
    );
    expect(f.packets).toHaveLength(1);
    expect(f.packets[0].domain).toBe(master.area.domain);
    expect(JSON.stringify(f.packets[0].value)).not.toContain("net_amount");
    expect(JSON.stringify(f.packets[0].value)).not.toContain("notes");
    await f.runtime.read([master, prices], (view) => {
      expect(view.row("commercial_cases", { id: "100" }).require("title")).toBe(
        "Neue Bezeichnung",
      );
      expect(
        view.row("commercial_cases", { id: "100" }).require("net_amount"),
      ).toBe("1234.56");
    });
    f.forbid(master.area.domain, "update");
    f.runtime.revalidate();
    await f.runtime.read([master], (view) =>
      expect(view.can(master, "update")).toBe(false),
    );
    await expect(
      f.runtime.transaction([master], (tx) => tx.require(master, "update")),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("commercial status and receipt share one publication and private amounts remain separate", async () => {
  const f = fixture();
  const { requests, master, prices } = commercialFixture(f);
  const id = "commercial:34:master-data:receipt:2u";
  const receipt = workflowReceiptRequest("34", [id]);
  try {
    await f.runtime.transaction([...requests, receipt], (tx) => {
      tx.patch(
        "commercial_cases",
        { id: "100" },
        { status: "sent", net_amount: "2345.67" },
      );
      tx.patch(
        "commercial_documents",
        { id: "101" },
        { net_amount: "2345.67" },
      );
      tx.create(receipt, id, {
        format: "sortsys-workflow-receipt-v1",
        caseId: "34",
        eventId: "2u",
        previousStatus: "draft",
        status: "sent",
        createdAt: "2026-11-11T12:00:00Z",
        documents: [],
      });
    });
    expect(f.calls.commit).toBe(1);
    expect(f.packets).toHaveLength(3);
    expect(
      f.packets.filter((packet) => packet.domain === master.area.domain),
    ).toHaveLength(2);
    expect(
      f.packets.filter((packet) => packet.domain === prices.area.domain),
    ).toHaveLength(1);
    const masterText = JSON.stringify(
      f.state(master.area).objects.get(master.area.prefix).value,
    );
    expect(masterText).toContain('"sent"');
    expect(masterText).not.toContain("2345.67");
    f.reject(true);
    await expect(
      f.runtime.transaction(requests, (tx) =>
        tx.patch(
          "commercial_cases",
          { id: "100" },
          { status: "accepted", net_amount: "9999.99" },
        ),
      ),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    await f.runtime.read(requests, (view) => {
      expect(
        view.row("commercial_cases", { id: "100" }).require("status"),
      ).toBe("sent");
      expect(
        view.row("commercial_cases", { id: "100" }).require("net_amount"),
      ).toBe("2345.67");
    });
    await expect(
      f.runtime.transaction([receipt], (tx) =>
        tx.create(receipt, id + "-substitute", {
          format: "sortsys-workflow-receipt-v1",
          caseId: "34",
          eventId: "2u",
          previousStatus: "draft",
          status: "sent",
          createdAt: "2026-11-11T12:00:00Z",
          documents: [],
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a partial soft refresh excludes stale related rows until their heads are checked", async () => {
  const f = fixture();
  const tool = toolRequest("tool", "34", "master-data");
  const old = toolRequest("tool-tracking", "35", "master-data");
  const next = toolRequest("tool-tracking", "36", "master-data");
  const master = row("tools", {
    id: "100",
    custom_id: "73",
    brand: "Muster",
    category: "Bohrhammer",
  });
  const tracking = row("tool_trackings", {
    id: "101",
    tool_id: "100",
    started_at: "2026-11-11T12:00:00Z",
  });
  f.seed(
    tool.area,
    tool.area.prefix,
    toolPart("tool", "34", "master-data", [master], "35"),
  );
  f.seed(
    old.area,
    old.area.prefix,
    toolPart("tool-tracking", "35", "master-data", [tracking]),
  );
  try {
    await f.runtime.read([tool, old], (view) =>
      expect(view.rows("tool_trackings").length).toBe(1),
    );
    f.seed(
      tool.area,
      tool.area.prefix,
      toolPart("tool", "34", "master-data", [master]),
    );
    f.seed(
      old.area,
      old.area.prefix,
      toolPart("tool-tracking", "35", "master-data", [
        row("tool_trackings", {
          ...tracking.values,
          ended_at: "2026-11-11T13:00:00Z",
        }),
      ]),
    );
    f.runtime.revalidate();
    await f.runtime.read([tool], async (view) => {
      expect(view.documents(tool)[0].value.activeTrackingId).toBeNull();
      expect(view.rows("tool_trackings")).toEqual([]);
      expect(() => view.documents(old)).toThrow();
      await expect(
        view.query(
          { tool_trackings: ["id"] },
          "SELECT count(*) FROM tool_trackings",
        ),
      ).rejects.toThrow();
    });
    await f.runtime.transaction([tool, next], (tx) => {
      tx.edit(tool, tool.area.prefix, (value) => {
        value.activeTrackingId = "36";
      });
      tx.create(
        next,
        next.area.prefix,
        toolPart("tool-tracking", "36", "master-data", [
          row("tool_trackings", {
            id: "102",
            tool_id: "100",
            started_at: "2026-11-11T14:00:00Z",
          }),
        ]),
      );
    });
    expect(f.calls.commit).toBe(1);
    await f.runtime.read([old], (view) =>
      expect(
        view.row("tool_trackings", { id: "101" }).require("ended_at"),
      ).toBe("2026-11-11T13:00:00Z"),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("non-tabular templates share transactions and refresh only their own area", async () => {
  const f = fixture();
  const template = {
    model: defineDataModel({
      name: "print-template-test",
      tables: [],
      decode: printTemplatePayload,
    }),
    area: PRINT_COLLECTION,
  };
  f.seed(template.area, PRINT_OBJECT, {
    format: "sortsys-print-template-v1",
    source: "// Original",
    assets: [],
  });
  try {
    await f.runtime.read([template], (view) =>
      expect(view.documents(template)[0].value.source).toBe("// Original"),
    );
    expect(f.calls.drivers).toBe(0);
    await f.runtime.read([first, second], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654),
    );
    f.seed(template.area, PRINT_OBJECT, {
      format: "sortsys-print-template-v1",
      source: "// From another client",
      assets: [],
    });
    f.runtime.revalidate(new Set([PRINT_COLLECTION.domain]));
    await f.runtime.read([first], (view) => {
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654);
      expect(() => view.documents(template)).toThrow();
    });
    await f.runtime.read([template], (view) =>
      expect(view.documents(template)[0].value.source).toBe(
        "// From another client",
      ),
    );
    f.lose(true);
    await f.runtime.transaction([template], (tx) => {
      tx.require(template, "update");
      tx.edit(template, PRINT_OBJECT, (value) => {
        value.source = "// Saved through the shared runtime";
      });
    });
    expect(f.calls.commit).toBe(1);
    expect(f.calls.drivers).toBe(1);
    f.forbid(template.area.domain, "update");
    await expect(
      f.runtime.transaction([template], (tx) => {
        tx.require(template, "update");
      }),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("opening a non-tabular form before a catalogue preserves the configured SQL driver", async () => {
  const f = fixture(true);
  const template = {
    model: defineDataModel({
      name: "print-before-sql",
      tables: [],
      decode: printTemplatePayload,
    }),
    area: PRINT_COLLECTION,
  };
  f.seed(template.area, PRINT_OBJECT, {
    format: "sortsys-print-template-v1",
    source: "// Before SQL",
    assets: [],
  });
  try {
    await f.runtime.read([template], (view) =>
      expect(view.documents(template)[0].value.source).toBe("// Before SQL"),
    );
    expect(f.calls.drivers).toBe(0);
    f.runtime.configureDriver(f.driverFactory);
    f.runtime.configureDriver(f.driverFactory);
    let replacements = 0;
    const laterFactory = async () => {
      replacements++;
      throw new Error("Must not replace an existing driver");
    };
    f.runtime.configureDriver(laterFactory);
    await f.runtime.read([first, second], (view) =>
      expect(
        view.row("product_price_records", { id: "1" }).require("price"),
      ).toBe(87.654),
    );
    expect(f.calls.drivers).toBe(1);
    f.runtime.configureDriver(laterFactory);
    expect(replacements).toBe(0);
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("a logical deletion uses delete permission, removes projected rows and verifies the empty record after a lost reply", async () => {
  const f = fixture();
  f.allowDelete();
  f.forbid(first.area.domain, "update");
  f.forbid(first.area.domain, "create");
  f.lose(true);
  try {
    await f.runtime.transaction([first], (tx) => {
      tx.delete(first, "main:1");
      expect(tx.documents(first)).toEqual([]);
      expect(tx.rows("product_price_records")).toEqual([]);
      expect(() => tx.edit(first, "main:1", () => {})).toThrow();
      expect(() =>
        tx.create(first, "main:1", {
          row: row("product_price_records", { id: "1", product_id: "2" }),
        }),
      ).toThrow();
    });
    expect(f.packets).toHaveLength(1);
    expect(f.packets[0].envelope.format).toBe(TOMBSTONE_FORMAT);
    expect(f.packets[0].value).toBeNull();
    await f.runtime.read([first], (view) =>
      expect(view.documents(first)).toEqual([]),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);
test("denied and failed deletions never remove the last committed view", async () => {
  const f = fixture();
  try {
    await expect(
      f.runtime.transaction([first], (tx) => tx.delete(first, "main:1")),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    f.allowDelete();
    f.reject(true);
    await expect(
      f.runtime.transaction([first], (tx) => tx.delete(first, "main:1")),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    await f.runtime.read([first], (view) =>
      expect(view.documents(first)[0].value.row.values.comment).toBe("Vorher"),
    );
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("one atomic publication can delete one object and edit another without granting update on the deleted area", async () => {
  const f = fixture();
  f.allowDelete();
  f.forbid(mainArea.domain, "update");
  const model = defineDataModel({
    name: "independent-atomic-notes",
    tables: [],
    decode: (value) => value,
  });
  const left = { model, area: { ...mainArea, prefix: "note:left:" } };
  const right = { model, area: { ...privateArea, prefix: "note:right:" } };
  f.seed(left.area, "note:left:1", { title: "Delete this" });
  f.seed(right.area, "note:right:2", { title: "Keep this" });
  const work = (tx) => {
    tx.delete(left, "note:left:1");
    tx.edit(right, "note:right:2", (value) => {
      value.title = "Changed atomically";
    });
  };
  try {
    f.reject(true);
    await expect(
      f.runtime.transaction([left, right], work),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    await f.runtime.read([left, right], (view) => {
      expect(view.documents(left)).toHaveLength(1);
      expect(view.documents(right)[0].value.title).toBe("Keep this");
    });
    f.reject(false);
    f.lose(true);
    await f.runtime.transaction([left, right], work);
    expect(f.packets).toHaveLength(2);
    await f.runtime.read([left, right], (view) => {
      expect(view.documents(left)).toEqual([]);
      expect(view.documents(right)[0].value.title).toBe("Changed atomically");
    });
  } finally {
    await f.runtime.close();
  }
}, 15000);

test("caller cancellation stops a prepared transaction before publication and leaves the runtime usable", async () => {
  const f = fixture();
  const request = {
    model: defineDataModel({
      name: "cancelled-form",
      tables: [],
      decode: (value) => value,
    }),
    area: PRINT_COLLECTION,
  };
  f.seed(request.area, PRINT_OBJECT, { source: "Original" });
  const cancellation = new AbortController();
  const open = f.storage.open;
  f.storage.open = async (signal) => {
    const collections = await open(signal);
    return Object.assign(
      (area) => {
        const collection = collections(area);
        const packet = collection.packet;
        collection.packet = async (...arguments_) => {
          const prepared = await packet(...arguments_);
          cancellation.abort();
          return prepared;
        };
        return collection;
      },
      { readable: collections.readable },
    );
  };
  try {
    await expect(
      f.runtime.transaction(
        [request],
        (tx) => {
          tx.edit(request, PRINT_OBJECT, (value) => {
            value.source = "Cancelled";
          });
        },
        { signal: cancellation.signal, retries: 2 },
      ),
    ).rejects.toThrow();
    expect(f.calls.commit).toBe(0);
    expect(f.state(request.area).objects.get(PRINT_OBJECT).value.source).toBe(
      "Original",
    );
    f.storage.open = open;
    await f.runtime.transaction([request], (tx) => {
      tx.edit(request, PRINT_OBJECT, (value) => {
        value.source = "Saved";
      });
    });
    expect(f.calls.commit).toBe(1);
    expect(f.state(request.area).objects.get(PRINT_OBJECT).value.source).toBe(
      "Saved",
    );
    let entered = false;
    await expect(
      f.runtime.transaction(
        [request],
        () => {
          entered = true;
        },
        { signal: cancellation.signal },
      ),
    ).rejects.toThrow();
    expect(entered).toBe(false);
  } finally {
    await f.runtime.close();
  }
});
