import { expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import {
  checkedImportHistory,
  checkImportHistoryUsers,
  importHistoryBlob,
  inspectImportHistory,
  selectImportHistory,
} from "./importHistory";
import {
  importHistoryCollection,
  importHistoryOrigin,
  legacyImportEntry,
  prepareImportHistory,
} from "../data/migrateImportHistory";
import {
  oldScan,
  scanResult,
  scanSourceSql,
} from "../data/testing/importHistory.mjs";
import { openPostgresBackup } from "./business";
import { row, sourceSql } from "../data/testing/businessRow.mjs";
import { duckDriver } from "../data/testing/duckDriver.mjs";
import { fixtureTimeout } from "../data/testing/fixtureTimeout.mjs";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";

const signal = () => new AbortController().signal;

test("administration SQL is read locally and only the selected tenant's exact scan rows are archived", async () => {
  const dump = new Blob([
    "COPY public.__tenants (name,password) FROM stdin;\nother-tenant\tPrivate old credential 219453\n\\.\n",
    scanSourceSql([
      oldScan(),
      oldScan({ id: "20", user_id: "89", state: "matching", result: null }),
      oldScan({
        tenant_name: "other-tenant",
        file_name: "Other tenant secret 742963.png",
      }),
    ]),
  ]);
  const gzip = await new Response(
    dump.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  expect(await inspectImportHistory(gzip, signal())).toEqual([
    { tenant: "old-tenant", entries: 2 },
    { tenant: "other-tenant", entries: 1 },
  ]);
  const selected = await selectImportHistory(gzip, "old-tenant", signal());
  expect(selected.records).toHaveLength(2);
  expect(selected.records[0].values.source_object_key).toBe(
    oldScan().source_object_key,
  );
  const converted = legacyImportEntry(
    selected.records[0],
    importHistoryOrigin(selected.records[0]),
    "backup:fixture",
  );
  expect(converted.subject).toBe("user:2n");
  expect(converted.entry.result).toEqual(scanResult);
  expect(converted.entry.createdAt).toBe("2026-11-12T10:00:00.123456Z");
  const archived = await importHistoryBlob(selected).text();
  expect(archived).not.toContain("Private old credential");
  expect(archived).not.toContain("Other tenant secret");
  expect(archived).not.toContain("other-tenant");
  expect(await checkedImportHistory(JSON.parse(archived), signal())).toEqual(
    selected,
  );
  await expect(
    selectImportHistory(dump, "missing-tenant", signal()),
  ).rejects.toThrow();
});

test("source validation rejects duplicate identities, foreign tenants, forged states and interrupted parsing", async () => {
  const source = await selectImportHistory(
    new Blob([scanSourceSql([oldScan()])]),
    "old-tenant",
    signal(),
  );
  const first = source.records[0];
  for (const invalid of [
    { ...source, records: [first, first] },
    { ...source, tenant: "another-tenant" },
    { ...source, records: [{ ...first, collection: "jobs" }] },
    {
      ...source,
      records: [{ ...first, values: { ...first.values, state: "ready" } }],
    },
    { ...source, records: [] },
    { ...source, extra: "untrusted" },
  ])
    await expect(checkedImportHistory(invalid, signal())).rejects.toThrow();

  const cancelled = new DOMException("Cancelled", "AbortError");
  await expect(
    checkedImportHistory(source, AbortSignal.abort(cancelled)),
  ).rejects.toBe(cancelled);
  await expect(
    selectImportHistory(
      new Blob([scanSourceSql([oldScan(), oldScan()])]),
      "old-tenant",
      signal(),
    ),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    inspectImportHistory(
      new Blob([scanSourceSql([oldScan()])]),
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(
    inspectImportHistory(
      new Blob(["COPY public.__tenants (name) FROM stdin;\nold-tenant\n\\.\n"]),
      signal(),
    ),
  ).rejects.toThrow("keinen Einleseverlauf");
});

test("copies short and long scan histories into their own areas without rewriting on retry", async () => {
  const owners = ["user:1", "user:2"];
  const areas = owners.map(importHistoryCollection);
  const tenant = await protectedTenant(areas, undefined, { backup: true });

  try {
    const rows = [
      oldScan({ user_id: "1" }),
      ...["20", "21", "22"].map((id) => oldScan({ id, user_id: "2" })),
    ];
    const { records } = await selectImportHistory(
      new Blob([scanSourceSql(rows)]),
      "old-tenant",
      signal(),
    );
    const context = tenant.setup.authority.context;
    const copy = (source = records) =>
      prepareImportHistory(tenant.client, source, owners[0], context, signal());

    tenant.state.loseReply = true;
    await copy();

    for (const record of records) {
      const { subject, id, entry } = legacyImportEntry(
        record,
        importHistoryOrigin(record),
        context,
      );
      const object = `assistant:scan:${id}`;
      const stored = await tenant.plain(importHistoryCollection(subject), object);
      expect(stored).toEqual({
        format: "sortsys-assistant-v1",
        kind: "scan",
        id,
        value: entry,
      });
    }

    const saved = structuredClone([...tenant.objects]);
    expect(saved).toHaveLength(records.length);

    const beforeReplay = tenant.calls.length;
    await copy();
    expect([...tenant.objects]).toEqual(saved);
    const replay = tenant.calls.slice(beforeReplay);
    expect(replay.some(({ path }) => path === "zerotrust.objects.batch")).toBe(false);

    const [first, ...rest] = records;
    const changed = {
      ...first,
      values: { ...first.values, file_name: "Andere Datei.png" },
    };
    await expect(copy([changed, ...rest])).rejects.toThrow();
    expect([...tenant.objects]).toEqual(saved);
    expect(JSON.stringify(tenant.calls)).not.toContain(rows[0].file_name);
  } finally {
    await lockCryptoSession();
  }
}, fixtureTimeout(20_000));

test("scan owners must exist in the tenant source rather than silently creating unrelated user areas", async () => {
  const user = row("users", {
    id: "87",
    username: "owner",
    contract_type: "internal",
    ui_locale: "de",
  });
  const sql = new Blob([sourceSql([user])]);
  const opened = await openPostgresBackup(sql, signal(), await duckDriver());
  try {
    for (const [id, allowed] of [
      ["87", true],
      ["89", false],
    ]) {
      const source = await selectImportHistory(
        new Blob([scanSourceSql([oldScan({ user_id: id })])]),
        "old-tenant",
        signal(),
      );
      if (allowed) await checkImportHistoryUsers(source, opened.database);
      else
        await expect(
          checkImportHistoryUsers(source, opened.database),
        ).rejects.toThrow("Benutzer");
    }
  } finally {
    await opened.database.close();
  }
}, fixtureTimeout(5_000));
