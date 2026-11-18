import { afterEach, expect, test } from "bun:test";
import {
  base64,
  objectKeyRecipientBinding,
  signResourceAccess,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession, trustedHistory } from "../crypto/session";
import {
  assignmentProject,
  readOwnAssignments,
  verifyPlanningRecipient,
} from "./planningRecipients";
import { protectedCollection } from "./protectedObjects";
import { createProtectedProjectSchedule } from "./projectSchedule";
import { duckDriver } from "./testing/duckDriver.mjs";
import { scheduleCollection, scheduleObject } from "./projectScheduleData";
import { row } from "./rowCodec.test.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";

afterEach(() => lockCryptoSession());

async function fixture(actions) {
  const area = scheduleCollection("2");
  const tenant = await protectedTenant([area], actions);
  const object = scheduleObject("2", "deployment", "3");
  const payload = {
    format: "sortsys-project-schedule-v1",
    row: row("project_deployments", {
      id: "3",
      project_id: "2",
      user_id: "1",
      from: "2026-11-18T08:00:00Z",
      to: "2026-11-18T16:00:00Z",
      note: "Private own assignment 183649",
    }),
  };
  const envelope = await tenant.seed(area, object, payload, {
    policyVersion: actions ? "2" : "1",
  });
  return {
    ...tenant,
    area,
    object,
    payload,
    envelope,
    history: await trustedHistory(tenant.client),
  };
}

test("own assignments open with a record key and writer proofs without any containing-area key request", async () => {
  const f = await fixture();
  f.calls.length = 0;
  const rows = await readOwnAssignments(f.client, new AbortController().signal);
  expect(rows.map((document) => document.value.row.values.note)).toEqual([
    f.payload.row.values.note,
  ]);
  expect(f.calls.some((call) => isKeyEnvelopeQuery(call.path))).toBe(false);
  expect(f.calls.some((call) => call.path === "zerotrust.domains.get")).toBe(
    false,
  );
  expect(JSON.stringify(f.calls)).not.toContain(f.payload.row.values.note);
});

test("a correctly signed source and recipient envelope from a read-only author still cannot authorize an assignment", async () => {
  const f = await fixture(() => ["read"]);
  await expect(
    readOwnAssignments(f.client, new AbortController().signal),
  ).rejects.toThrow();
});

test("assignment addressing rejects noncanonical placements and never shares unavailability records", async () => {
  const f = await fixture();
  expect(assignmentProject(f.envelope)).toBe("2");
  expect(
    assignmentProject({
      ...f.envelope,
      object: "schedule:2:unavailability:3:3",
    }),
  ).toBeNull();
  for (const changed of [
    { object: "schedule:8:deployment:3:3" },
    { object: "schedule:2:deployment:3:03" },
    { object: "schedule:2:deployment:3:3:extra" },
    { facet: "calculation" },
  ])
    expect(() => assignmentProject({ ...f.envelope, ...changed })).toThrow();
});

test("missing, stripped, substituted and stale recipient intent cannot authenticate a source revision", async () => {
  const f = await fixture();
  const state = f.recipients.get(f.object);
  for (const changed of [
    null,
    { ...state, recipientKey: null },
    { ...state, domain: "project:8:planning:master-data" },
    { ...state, access: { ...state.access, active: false } },
    {
      ...state,
      recipientKey: {
        ...state.recipientKey,
        envelope: {
          ...state.recipientKey.envelope,
          signature: base64(new Uint8Array(64)),
        },
      },
    },
  ])
    await expect(
      verifyPlanningRecipient(changed, f.envelope, f.payload, f.history),
    ).rejects.toThrow();
  await expect(
    verifyPlanningRecipient(
      state,
      { ...f.envelope, revision: "2" },
      f.payload,
      f.history,
    ),
  ).rejects.toThrow();
  const wrongPerson = structuredClone(f.payload);
  wrongPerson.row.values.user_id = "6";
  await expect(
    verifyPlanningRecipient(state, f.envelope, wrongPerson, f.history),
  ).rejects.toThrow();
});

for (const substitution of [
  "wrong-recipient",
  "writer-proof",
  "ciphertext",
  "repeated-object",
]) {
  test(`own assignment reads reject ${substitution} substitution before publishing results`, async () => {
    const f = await fixture();
    const query = f.client.query;
    f.client.query = async (path, input, options) => {
      const reply = await query(path, input, options);
      if (path !== "zerotrust.objects.shared" || !reply[0]) return reply;
      const page = structuredClone(reply[0]);
      const entry = page.objects[0];
      if (substitution === "wrong-recipient")
        entry.access.recipientKey.recipient.user = "user:6";
      if (substitution === "writer-proof")
        entry.proofs[0].proof = base64(new Uint8Array(64));
      if (substitution === "ciphertext")
        entry.envelope.ciphertext = base64(new Uint8Array(40));
      if (substitution === "repeated-object")
        page.objects.push(structuredClone(entry));
      return [page, null];
    };
    await expect(
      readOwnAssignments(f.client, new AbortController().signal),
    ).rejects.toThrow();
  });
}

test("parent reads require signed inactive intent for deletion and reject metadata stripped from a page", async () => {
  const f = await fixture();
  const collection = await protectedCollection(
    f.client,
    f.area,
    new AbortController().signal,
  );
  try {
    await collection.read();
    const packet = await collection.tombstone(f.object, f.envelope);
    expect(packet.envelope.format).toBe(TOMBSTONE_FORMAT);
    expect(packet.resourceAccess.active).toBe(false);
    expect(packet.recipientKey).toBeUndefined();
    const state = {
      domain: packet.domain,
      access: packet.resourceAccess,
      recipientKey: null,
    };
    await verifyPlanningRecipient(state, packet.envelope, null, f.history);
    const saved = f.recipients.get(f.object);
    f.recipients.delete(f.object);
    await expect(collection.read()).rejects.toThrow();
    f.recipients.set(f.object, saved);
  } finally {
    collection.close();
  }
});

test("a saved source cannot confirm a write whose exact recipient intent was replaced", async () => {
  const f = await fixture();
  const mutate = f.client.mutate;
  f.client.mutate = async (path, input) => {
    const reply = await mutate(path, input);
    if (path === "zerotrust.objects.batch" && reply[0]) {
      const packet = input.objects.find(
        (packet) => packet.envelope.object === f.object,
      );
      if (packet) {
        // A real API rejects this replacement. A malicious response adapter
        // must not turn it into a confirmed client-side save either.
        const { signature, ...access } = packet.resourceAccess;
        const inactive = await signResourceAccess(
          {
            ...access,
            active: false,
            binding: await objectKeyRecipientBinding(null, null),
          },
          f.identity.signingKey.privateKey,
        );
        f.recipients.set(f.object, {
          domain: packet.domain,
          access: inactive,
          recipientKey: null,
        });
      }
    }
    return reply;
  };
  const store = createProtectedProjectSchedule(
    f.client,
    new AbortController().signal,
    duckDriver,
  );
  try {
    await expect(
      store.mutate("projects.deployments.update", {
        id: "3",
        data: { note: "Changed assignment" },
      }),
    ).rejects.toThrow();
  } finally {
    store.close();
  }
});
