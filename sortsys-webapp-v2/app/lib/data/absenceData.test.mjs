import { expect, test } from "bun:test";
import { base64, createIdentity } from "@sortsys/zerotrust/sortsys";
import {
  ABSENCE_REQUEST_MODEL,
  ABSENCE_DECISION_MODEL,
  absenceCollection,
  absenceDecision,
  absenceInput,
  absenceRequest,
  absenceState,
  attestLegacyAbsence,
  vacationUsage,
  verifyLegacyAbsence,
} from "./absenceData";
import { row } from "./rowCodec.test.mjs";

const signature = base64(new Uint8Array(64).fill(1));
function request() {
  return {
    format: "sortsys-absence-request-v1",
    legacy: null,
    row: row("user_vacations", {
      id: "3",
      user_id: "2",
      requested_by_user_id: "1",
      from: "2026-12-28",
      to: "2027-01-05",
      status: "requested",
      absence_type: "vacation",
    }),
  };
}
function decision() {
  return {
    format: "sortsys-absence-decision-v1",
    userId: "2",
    id: "3",
    requestSignature: signature,
    status: "approved",
    denialReason: null,
    decidedByUserId: "1",
    decidedAt: "2026-11-12T12:00:00.123456Z",
    modifiedAt: "2026-11-12T12:00:00.123456Z",
    legacy: null,
  };
}
test("request and decision payloads reject invented status fields and bind exact owners and source signatures", () => {
  const source = absenceRequest(request(), "absence:2:request:3", "2"),
    result = absenceDecision(decision(), "absence:2:decision:3", "2");
  expect(absenceState(source, signature, result).values.status).toBe(
    "approved",
  );
  expect(source.row.values.status).toBe("requested");
  expect(() =>
    absenceState(source, base64(new Uint8Array(64).fill(2)), result),
  ).toThrow();
  expect(() =>
    absenceState(source, signature, { ...result, id: "4" }),
  ).toThrow();
  expect(() =>
    absenceRequest(
      {
        ...request(),
        row: {
          ...request().row,
          values: { ...request().row.values, status: "approved" },
        },
      },
      "absence:2:request:3",
      "2",
    ),
  ).toThrow();
  expect(() => absenceRequest(request(), "absence:4:request:3", "4")).toThrow();
  expect(() =>
    absenceDecision(
      { ...decision(), extra: true },
      "absence:2:decision:3",
      "2",
    ),
  ).toThrow();
  expect(() =>
    absenceDecision(
      { ...decision(), status: "denied", denialReason: " " },
      "absence:2:decision:3",
      "2",
    ),
  ).toThrow();
  expect(() =>
    absenceDecision(
      { ...decision(), decidedByUserId: null },
      "absence:2:decision:3",
      "2",
    ),
  ).toThrow();
});
test("live records bind their named actors to the authenticated envelope author", () => {
  const source = absenceRequest(request(), "absence:2:request:3", "2"),
    result = absenceDecision(decision(), "absence:2:decision:3", "2");
  expect(
    ABSENCE_REQUEST_MODEL.opened(source, {
      envelope: { revision: "1", author: "user:1" },
    }),
  ).toEqual(source);
  expect(() =>
    ABSENCE_REQUEST_MODEL.opened(source, {
      envelope: { revision: "1", author: "user:4" },
    }),
  ).toThrow();
  expect(() =>
    ABSENCE_DECISION_MODEL.opened(result, {
      envelope: { revision: "1", author: "user:4" },
    }),
  ).toThrow();
});
test("legacy actor and date claims need an exact tenant-authority attestation and cannot survive payload changes", async () => {
  const authority = await createIdentity();
  const original = request();
  original.row.values.requested_by_user_id = null;
  const attested = await attestLegacyAbsence(
    original,
    "tenant",
    "1",
    authority.signingKey.privateKey,
  );
  const checked = absenceRequest(attested, "absence:2:request:3", "2");
  await verifyLegacyAbsence(
    checked,
    "tenant",
    () => authority.signingKey.publicKey,
  );
  await expect(
    verifyLegacyAbsence(
      checked,
      "other-tenant",
      () => authority.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  await expect(
    verifyLegacyAbsence(
      {
        ...checked,
        row: {
          ...checked.row,
          values: { ...checked.row.values, note: "Geändert" },
        },
      },
      "tenant",
      () => authority.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  const oldDecision = { ...decision(), decidedByUserId: null, decidedAt: null };
  const converted = await attestLegacyAbsence(
    oldDecision,
    "tenant",
    "1",
    authority.signingKey.privateKey,
  );
  await verifyLegacyAbsence(
    absenceDecision(converted, "absence:2:decision:3", "2"),
    "tenant",
    () => authority.signingKey.publicKey,
  );
  const stranger = await createIdentity();
  await expect(
    verifyLegacyAbsence(
      converted,
      "tenant",
      () => stranger.signingKey.publicKey,
    ),
  ).rejects.toThrow();
});
test("absence forms keep vacation labels empty, require other labels and reject invalid date ranges", () => {
  expect(
    absenceInput({
      from: "2026-11-12",
      to: "2026-11-13",
      type: "other",
      label: "  Schulung  ",
    }).label,
  ).toBe("Schulung");
  for (const bad of [
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-03-01", to: "2026-02-28" },
    { from: "2026-03-01", to: "2026-03-02", type: "other" },
    { from: "2026-03-01", to: "2026-03-02", label: "Urlaub" },
  ])
    expect(() => absenceInput(bad)).toThrow();
  expect(absenceCollection("2", true).domain).toBe("absence:2:personnel");
});
test("vacation usage matches the old union-of-weekdays rule across years without double-counting overlaps", () => {
  const value = vacationUsage(
    { from: "2026-12-28", to: "2027-01-05" },
    [
      { from: "2026-12-24", to: "2026-12-30" },
      { from: "2026-12-28", to: "2027-01-01" },
    ],
    30,
  );
  expect(value).toEqual([
    {
      year: 2026,
      allowanceDays: 30,
      approvedDays: 6,
      requestedDays: 4,
      remainingAfterApproval: 24,
    },
    {
      year: 2027,
      allowanceDays: 30,
      approvedDays: 1,
      requestedDays: 3,
      remainingAfterApproval: 27,
    },
  ]);
  expect(
    vacationUsage({ from: "2026-11-14", to: "2026-11-15" }, [], null),
  ).toEqual([]);
  expect(
    vacationUsage({ from: "2028-02-28", to: "2028-03-01" }, [], null)[0],
  ).toMatchObject({
    requestedDays: 3,
    allowanceDays: null,
    remainingAfterApproval: null,
  });
});
test("interval arithmetic agrees with an independent daily-set oracle for overlapping ranges", () => {
  const date = (day) =>
    new Date(Date.UTC(2026, 0, 1) + day * 86400000).toISOString().slice(0, 10);
  let seed = 747;
  const random = (max) => {
    seed = (seed * 16807) % 2147483647;
    return seed % max;
  };
  const days = (from, to) => {
    const values = new Set();
    for (let day = from; day <= to; day++) {
      const weekday = new Date(
        Date.UTC(2026, 0, 1) + day * 86400000,
      ).getUTCDay();
      if (weekday !== 0 && weekday !== 6) values.add(day);
    }
    return values;
  };
  for (let sample = 0; sample < 40; sample++) {
    const from = random(50),
      to = from + random(30),
      ranges = Array.from({ length: 8 }, () => {
        const from = random(70);
        return [from, from + random(20)];
      });
    const approved = new Set(
        ranges.flatMap(([from, to]) => [...days(from, to)]),
      ),
      requested = days(from, to);
    const actual = vacationUsage(
      { from: date(from), to: date(to) },
      ranges.map(([from, to]) => ({ from: date(from), to: date(to) })),
      30,
    );
    if (!requested.size) expect(actual).toEqual([]);
    else
      expect(actual[0]).toEqual({
        year: 2026,
        allowanceDays: 30,
        approvedDays: approved.size,
        requestedDays: requested.size,
        remainingAfterApproval: 30 - new Set([...approved, ...requested]).size,
      });
  }
});
