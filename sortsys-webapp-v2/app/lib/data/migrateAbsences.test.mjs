import { afterEach, expect, test } from "bun:test";
import { ACTIONS, createIdentity } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { absenceCollection } from "./absenceData";
import { createProtectedAbsences } from "./absences";
import { copyAbsenceRecords } from "./migrateAbsences";
import { row } from "./rowCodec.test.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
afterEach(() => lockCryptoSession());
async function fixture() {
  const source = absenceCollection("2"),
    decision = absenceCollection("2", true);
  const f = await protectedTenant(
    [absenceCollection("1"), absenceCollection("1", true), source, decision],
    () => [...ACTIONS],
  );
  const authority = {
    tenant: "test",
    generation: "1",
    key: f.authorityKey.privateKey,
    publicKey: () => f.authorityKey.publicKey,
    live() {},
  };
  const values = [
    row("user_vacations", {
      id: "3",
      user_id: "2",
      requested_by_user_id: "2",
      absence_type: "vacation",
      status: "requested",
      from: "2026-11-16",
      to: "2026-11-18",
    }),
    row("user_vacations", {
      id: "4",
      user_id: "2",
      requested_by_user_id: "2",
      decided_by_user_id: "1",
      decided_at: "2026-11-01T00:00:00.000Z",
      absence_type: "vacation",
      status: "approved",
      from: "2026-11-23",
      to: "2026-11-24",
    }),
    row("user_vacations", {
      id: "5",
      user_id: "2",
      requested_by_user_id: null,
      decided_by_user_id: null,
      decided_at: null,
      absence_type: "other",
      label: "Schulung",
      status: "denied",
      denial_reason: "Termin verschoben",
      from: "2026-11-30",
      to: "2026-11-30",
    }),
  ];
  const copy = (rows = values, context = authority) =>
    copyAbsenceRecords(
      f.client,
      rows,
      ["1", "2"],
      context,
      new AbortController().signal,
      duckDriver,
    );
  return { ...f, source, decision, authority, values, copy };
}
test("absence migration preserves pending, approved and denied rows with authority-attested original actors", async () => {
  const f = await fixture();
  const rows = f.values;
  f.state.loseReply = true;
  await f.copy(rows);
  const store = createProtectedAbsences(
    f.client,
    new AbortController().signal,
    duckDriver,
  );
  try {
    const values = await store.query("users.vacations.list", {});
    expect(values).toHaveLength(3);
    expect(values.find((value) => value.id === "4")).toMatchObject({
      status: "approved",
      requestedByUserId: "2",
      decidedByUserId: "1",
    });
    expect(values.find((value) => value.id === "5")).toMatchObject({
      status: "denied",
      label: "Schulung",
      requestedByUserId: null,
      decidedByUserId: null,
      decidedAt: null,
      denialReason: "Termin verschoben",
    });
    const batches = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(batches.map((call) => call.input.objects.length)).toEqual([1, 2, 2]);
    const count = batches.length;
    await f.copy(rows);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(count);
    const replacement = await createIdentity();
    const recovered = {
      ...f.authority,
      generation: "2",
      key: replacement.signingKey.privateKey,
      publicKey: (generation) =>
        generation === "1"
          ? f.authorityKey.publicKey
          : replacement.signingKey.publicKey,
    };
    await f.copy(rows, recovered);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(count);
    expect(JSON.stringify(f.calls)).not.toContain("Termin verschoben");
    const changed = structuredClone(rows);
    changed[0].values.note = "Andere Quelldaten";
    await expect(f.copy(changed)).rejects.toThrow();
  } finally {
    store.close();
  }
}, 30000);
test("migration rejects destination extras and an invalid legacy attestation rather than adopting them", async () => {
  const f = await fixture(),
    source = structuredClone(f.values[0]);
  await f.copy([source]);
  const payload = await f.plain(f.source, f.source.prefix + "3");
  payload.row.values.note = "Manipuliert";
  // Envelope signed by an authorized user; the unchanged authority proof must
  // still fail independently of the valid envelope signature.
  f.objects.delete(f.source.prefix + "3");
  await f.seed(f.source, f.source.prefix + "3", payload);
  await expect(f.copy([source])).rejects.toThrow();
  const store = createProtectedAbsences(
    f.client,
    new AbortController().signal,
    duckDriver,
  );
  try {
    await expect(store.query("users.vacations.list", {})).rejects.toThrow();
  } finally {
    store.close();
  }
  f.objects.delete(f.source.prefix + "3");
  f.domains.get(f.source.domain).head++;
  const extra = structuredClone(source);
  extra.values.id = "6";
  await f.copy([extra]);
  await expect(f.copy([source])).rejects.toThrow();
}, 30000);
