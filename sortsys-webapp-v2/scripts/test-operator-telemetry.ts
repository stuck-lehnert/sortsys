import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createClient, RpcClientError } from "@sortsys/v2-client";
import {
  commitOwner,
  prepareOwner,
  tenantSetupRequest,
} from "../app/lib/crypto/tenantSetup";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { required } from "../app/lib/data/protectedObjects";
import { technicalErrorReport } from "../app/lib/errorTelemetry";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [, , output] = process.argv.slice(2);
assert.ok(output);
const endpoints: string[] = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.equal(endpoints.length, 2);
for (const endpoint of endpoints)
  assert.equal(new URL(endpoint).hostname, "127.0.0.1");
const tenant = "telemetry-tenant";
const operatorPassword = "Disposable-telemetry-operator-2026!";
const operator = createClient(endpoints[0]!, "telemetry-operator");
const operatorPeer = createClient(endpoints[1]!, "telemetry-operator-peer");
const scopedOperator = createClient(endpoints[1]!, "telemetry-scoped-operator");
const owner = createClient(endpoints[0]!, "telemetry-first-api");
const peer = createClient(endpoints[1]!, "telemetry-second-api");
const anonymous = createClient(endpoints[1]!, "telemetry-anonymous");
let lostSnapshotResponse = false;
const interruptedOperator = createClient(
  endpoints[0]!,
  "interrupted-operator",
  {
    fetch: (async (input, options) => {
      const response = await fetch(input, options);
      if (
        !lostSnapshotResponse &&
        new URL(String(input)).pathname.includes(
          "admin.storage.snapshots.create",
        )
      ) {
        await response.arrayBuffer();
        lostSnapshotResponse = true;
        throw new TypeError("Simulated lost snapshot response");
      }
      return response;
    }) as typeof globalThis.fetch,
  },
);
const secret = "TEST-CONFIDENTIAL-PRICE-123.45";
const report = technicalErrorReport(
  {
    source: "gaeb.autosave",
    path: `/gaeb/${secret}`,
    status: 409,
  },
  "a".repeat(40),
);

function operatorReports() {
  return required(
    operator.query(
      "admin.errors.list",
      { tenant, limit: 200 },
      { strategy: "network-only" },
    ),
  );
}

let stage = "owner setup";
try {
  const login = await required(
    operator.mutate("admin.login", {
      tenant: null,
      password: operatorPassword,
    }),
  );
  operator.setToken(login.token);
  interruptedOperator.setToken(login.token);
  const setup = await tenantSetupRequest(tenant);
  await required(operator.mutate("admin.tenants.create", setup.request));
  const draft = await prepareOwner(
    owner,
    setup.link,
    "reporter",
    "Disposable-reporter-password-2026!",
  );
  await commitOwner(owner, draft);
  await signIn(peer, {
    tenant,
    username: "reporter",
    password: "Disposable-reporter-password-2026!",
  });
  const scoped = await required(
    scopedOperator.mutate("admin.login", {
      tenant,
      password: operatorPassword,
    }),
  );
  scopedOperator.setToken(scoped.token);

  const [, anonymousError] = await anonymous.mutate(
    "errorReports.report",
    report,
  );
  assert.ok(anonymousError instanceof RpcClientError);
  assert.equal(anonymousError?.code, "UNAUTHORIZED");
  stage = "malformed authenticated reports";
  const invalid = [
    { ...report, source: secret },
    { ...report, message: secret },
    { ...report, stack: secret },
    { ...report, componentStack: secret },
    { ...report, path: `/gaeb/${secret}` },
    { ...report, metadata: { revision: "development", secret } },
    { ...report, metadata: { revision: secret } },
    { ...report, metadata: { revision: "development", status: 999 } },
  ];
  for (const value of invalid) {
    const [, rejected] = await owner.mutateDynamic(
      "errorReports.report",
      value,
    );
    assert.ok(rejected instanceof RpcClientError);
    assert.equal(rejected?.code, "BAD_REQUEST");
  }
  assert.deepEqual(await operatorReports(), []);
  await required(owner.mutate("errorReports.report", report));
  stage = "operator output";
  const first = await operatorReports();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.path, "/gaeb");
  assert.deepEqual(first[0]!.metadata, {
    revision: "a".repeat(40),
    status: 409,
  });
  assert.equal(first[0]!.stack, null);
  assert.equal(first[0]!.componentStack, null);
  assert.equal(first[0]!.userAgent, null);
  assert.ok(first[0]!.createdAt instanceof Date);
  stage = "concurrent API reports";
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const client = index % 2 === 0 ? owner : peer;
      const source = index % 2 === 0 ? "client.query" : "client.mutate";
      await required(
        client.mutate(
          "errorReports.report",
          technicalErrorReport({ source, path: "/products" }, "development"),
        ),
      );
    }),
  );
  stage = "shared quota";
  for (let index = 0; index < 32; index++) {
    await required(
      (index % 2 === 0 ? owner : peer).mutate("errorReports.report", report),
    );
  }
  const reports = await operatorReports();
  assert.ok(reports.length >= 9 && reports.length <= 41);
  assert.ok(reports.some((value) => value.source === "client.query"));
  assert.ok(reports.some((value) => value.source === "client.mutate"));
  const perMinute = new Map<number, number>();
  for (const value of reports) {
    const minute = Math.floor(value.createdAt.getTime() / 60_000);
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
  }
  for (const count of perMinute.values())
    assert.ok(count <= 20, "Both API instances share the tenant quota");
  const encoded = JSON.stringify(reports);
  assert.equal(encoded.includes(secret), false);
  stage = "encrypted snapshots across replicas";
  const secondLogin = await required(
    operatorPeer.mutate("admin.login", {
      tenant: null,
      password: operatorPassword,
    }),
  );
  operatorPeer.setToken(secondLogin.token);
  const snapshotInput = { tenant, operation: crypto.randomUUID() };
  const snapshots = await Promise.all(
    [operator, operatorPeer].map((client) =>
      required(client.mutate("admin.storage.snapshots.create", snapshotInput)),
    ),
  );
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.ok(snapshots[0]!.bytes! > 4096);
  assert.ok(snapshots[0]!.createdAt instanceof Date);
  const snapshotPage = await required(
    operatorPeer.query("admin.storage.snapshots.list", { tenant }),
  );
  assert.deepEqual(snapshotPage.rows, [snapshots[0]]);
  assert.equal(snapshotPage.after, null);
  const snapshotPath = `/operator/snapshots/${tenant}/${snapshotInput.operation}`;
  const firstDownload = await operator.resource(snapshotPath);
  assert.equal(firstDownload.status, 200);
  assert.equal(firstDownload.headers.get("cache-control"), "no-store");
  assert.equal(firstDownload.headers.get("x-content-type-options"), "nosniff");
  const firstBytes = Buffer.from(await firstDownload.arrayBuffer());
  assert.equal(firstBytes.length, snapshots[0]!.bytes);
  const repeated = await required(
    operatorPeer.mutate("admin.storage.snapshots.create", snapshotInput),
  );
  assert.deepEqual(repeated, snapshots[0]);
  const replayDownload = await operatorPeer.resource(snapshotPath);
  assert.deepEqual(Buffer.from(await replayDownload.arrayBuffer()), firstBytes);
  stage = "lost snapshot response";
  const interruptedInput = { tenant, operation: crypto.randomUUID() };
  const [, interrupted] = await interruptedOperator.mutate(
    "admin.storage.snapshots.create",
    interruptedInput,
  );
  assert.equal(lostSnapshotResponse, true);
  assert.ok(interrupted instanceof Error);
  const resumed = await required(
    operatorPeer.mutate("admin.storage.snapshots.create", interruptedInput),
  );
  assert.equal(resumed.id, interruptedInput.operation);
  const resumedPage = await required(
    operatorPeer.query(
      "admin.storage.snapshots.list",
      { tenant },
      { strategy: "network-only" },
    ),
  );
  assert.equal(
    resumedPage.rows.length,
    2,
    "A lost acknowledgement cannot create a second copy of the same operation",
  );
  const [, stalePage] = await operatorPeer.query(
    "admin.storage.snapshots.list",
    {
      tenant,
      after: `${tenant}:${snapshotInput.operation}`,
      version: snapshotPage.version,
    },
  );
  assert.equal(stalePage?.code, "CONFLICT");
  const otherTenant = "telemetry-other";
  const otherSetup = await tenantSetupRequest(otherTenant);
  await required(operator.mutate("admin.tenants.create", otherSetup.request));
  const wrongTenant = await operatorPeer.resource(
    `/operator/snapshots/${otherTenant}/${snapshotInput.operation}`,
  );
  assert.equal(wrongTenant.status, 404);
  const [, invalidCursor] = await operatorPeer.query(
    "admin.storage.snapshots.list",
    { tenant, after: "invalid" },
  );
  assert.equal(invalidCursor?.code, "BAD_REQUEST");
  const [, invalidOperation] = await operatorPeer.mutate(
    "admin.storage.snapshots.create",
    { tenant, operation: "../private" },
  );
  assert.ok(invalidOperation instanceof RpcClientError);
  assert.equal(invalidOperation.code, "BAD_REQUEST");
  stage = "operator authorization";
  for (const restricted of [owner, scopedOperator, anonymous]) {
    const deniedDownload = await restricted.resource(snapshotPath);
    assert.ok([401, 403].includes(deniedDownload.status));
    const [, deniedCreate] = await restricted.mutate(
      "admin.storage.snapshots.create",
      {
        tenant,
        operation: crypto.randomUUID(),
      },
    );
    assert.ok(deniedCreate instanceof RpcClientError);
    assert.ok(["FORBIDDEN", "UNAUTHORIZED"].includes(deniedCreate.code ?? ""));
    const [, deniedList] = await restricted.query(
      "admin.storage.snapshots.list",
      { tenant },
    );
    assert.ok(
      deniedList &&
        ["FORBIDDEN", "UNAUTHORIZED"].includes(deniedList.code ?? ""),
    );
    const [, denied] = await restricted.query("admin.errors.list", {
      tenant,
      limit: 200,
    });
    assert.ok(
      denied && ["FORBIDDEN", "UNAUTHORIZED"].includes(denied.code ?? ""),
    );
  }
  await writeFile(
    output,
    JSON.stringify({
      success: true,
      telemetry: true,
      snapshots: true,
      reports: reports.length,
      minutes: perMinute.size,
    }),
  );
  console.log(
    "Native operator controls verified: private diagnostics, shared quotas, isolated encrypted snapshots, concurrent replicas and a lost snapshot response.",
  );
} catch (error) {
  console.error("Native diagnostic test failed during", stage);
  throw error;
} finally {
  await lockCryptoSession();
  for (const client of [
    operator,
    operatorPeer,
    interruptedOperator,
    scopedOperator,
    owner,
    peer,
    anonymous,
  ])
    client.setToken(null);
}
