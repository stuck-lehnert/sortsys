import { afterEach, expect, test } from "bun:test";
import { objectWriteAction, record } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { protectedCollection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";
import { acquireDataRuntime } from "./runtime/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());
const source = {
  domain: "absence:2:master-data",
  scope: "absence:2",
  facet: "master-data",
  prefix: "absence:2:request:",
};
const decisions = {
  domain: "absence:2:personnel",
  scope: "absence:2",
  facet: "personnel",
  prefix: "absence:2:decision:",
};
const model = defineDataModel({
  name: "test-absence-records",
  tables: [],
  decode(value) {
    return record(value, ["text", "requestSignature"]);
  },
});
test("the shared encrypted transaction can publish an approval without granting ordinary create/update", async () => {
  const f = await protectedTenant([source, decisions], (area) =>
    area === source ? ["read", "create", "delete"] : ["read", "approve"],
  );
  const signal = new AbortController().signal,
    lease = acquireDataRuntime(f.client, signal),
    request = { model, area: source },
    decision = { model, area: decisions };
  try {
    const original = await f.seed(source, source.prefix + "3", {
      text: "Vertraulicher Antrag",
      requestSignature: null,
    });
    f.state.loseReply = true;
    await lease.runtime.transaction([request, decision], (tx) => {
      expect(tx.can(decision, "approve")).toBe(true);
      expect(tx.can(decision, "create")).toBe(false);
      expect(tx.can(decision, "update")).toBe(false);
      tx.require(decision, "approve");
      const parent = tx.documents(request)[0];
      tx.create(decision, decisions.prefix + "3", {
        text: "Vertrauliche Entscheidung",
        requestSignature: parent.signature,
      });
    });
    const packet = f.calls.find(
      (call) => call.path === "zerotrust.objects.batch",
    ).input;
    expect(packet.heads.map((head) => head.domain).sort()).toEqual(
      [source.domain, decisions.domain].sort(),
    );
    expect(objectWriteAction(packet.objects[0].envelope)).toBe("approve");
    const result = await lease.runtime.read(
      [decision],
      (view) => view.documents(decision)[0].value,
    );
    expect(result.requestSignature).toBe(original.signature);
    expect(JSON.stringify(f.calls)).not.toContain("Vertrauliche Entscheidung");
    await expect(
      lease.runtime.transaction([decision], (tx) =>
        tx.edit(decision, decisions.prefix + "3", (value) => {
          value.text = "Nicht änderbar";
        }),
      ),
    ).rejects.toThrow();
  } finally {
    lease.close();
  }
});
test("a normal writer cannot seal a decision and no writer can rewrite an existing request", async () => {
  const f = await protectedTenant([source, decisions], () => [
      "read",
      "create",
      "update",
      "delete",
    ]),
    signal = new AbortController().signal;
  const request = await protectedCollection(f.client, source, signal),
    decision = await protectedCollection(f.client, decisions, signal);
  try {
    await expect(
      decision.packet(decisions.prefix + "3", { status: "approved" }),
    ).rejects.toThrow();
    const original = await f.seed(source, source.prefix + "3", {
      text: "Unveränderlicher Antrag",
    });
    await expect(
      request.packet(
        source.prefix + "3",
        { text: "Anderer Zeitraum" },
        original,
      ),
    ).rejects.toThrow();
    expect(
      f.calls.some((call) => call.path === "zerotrust.objects.batch"),
    ).toBe(false);
  } finally {
    request.close();
    decision.close();
  }
});
test("an approver without source read access cannot seal a blind decision", async () => {
  const f = await protectedTenant([source, decisions], (area) =>
    area === decisions ? ["read", "approve"] : [],
  );
  const decision = await protectedCollection(
    f.client,
    decisions,
    new AbortController().signal,
  );
  try {
    await expect(
      decision.packet(decisions.prefix + "3", { status: "approved" }),
    ).rejects.toThrow();
  } finally {
    decision.close();
  }
});
