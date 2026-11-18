import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, RpcClientError, type Client } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import {
  commitOwner,
  prepareOwner,
  tenantSetupRequest,
} from "../app/lib/crypto/tenantSetup";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import type { RestoredOfficeRoom } from "./test-native-office-restore";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const phase = process.env.SORTSYS_NATIVE_COLD_RESTORE_PHASE;
const root = process.env.SORTSYS_NATIVE_COLD_RESTORE_ROOT ?? "";
assert.ok(root);
assert.ok(phase === "source" || phase === "stale" || phase === "restored");
const fixturePath = join(root, "recovery-fixture.json");
const officeRestore =
  process.env.TEST_OFFICE_COLD_RESTORE === "1"
    ? await import("./test-native-office-restore")
    : null;

const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT ?? "";
assert.ok(tenant);
const otherTenant = "unaffected-tenant";
const username = "restoration-test";
const originalPassword = "Disposable-before-restoration-2026!";
const currentPassword = "Disposable-after-first-recovery-2026!";
const nextPassword = "Disposable-after-second-recovery-2026!";
const otherPassword = "Disposable-unaffected-tenant-2026!";
const originalTitle = "Vertrauliche Aufmaßunterlagen 761221";
const currentTitle = "Aufmaß nach der ersten Wiederherstellung 471663";
const nextTitle = "Projektänderung nach dem Neustart 693801";
const fileName = "Vertrauliche Aufmaßnotiz.txt";
const fileBytes = new TextEncoder().encode(
  "Aufmaß mit vertraulichen Werten 335279\n",
);
const signal = new AbortController().signal;

type Fixture = {
  administrator: string;
  snapshotOperation: string;
  project: string;
  file: string;
  retiredPhrase: string;
  currentPhrase: string;
  retiredToken: string;
  currentToken: string;
  officeRooms?: RestoredOfficeRoom[];
};

let lastBearer: string | undefined;
const captureBearer = new Proxy(globalThis.fetch, {
  apply(target, receiver, args) {
    const authorization = new Headers(args[1]?.headers).get("authorization");
    if (authorization?.startsWith("Bearer "))
      lastBearer = authorization.slice(7);
    return Reflect.apply(target, receiver, args);
  },
});
const first = createClient(endpoints[0], "cold-restore-first", {
  fetch: captureBearer,
});
const second = createClient(endpoints[1], "cold-restore-second", {
  fetch: captureBearer,
});
const operator = createClient(endpoints[0], "cold-restore-operator");

function openBusiness(client: Client) {
  return createBusinessClient(client, { productDriver: duckDriver });
}

async function signInOperator() {
  const login = await required(
    operator.mutate("admin.login", {
      tenant: null,
      password: "Disposable-operator-password-2026!",
    }),
  );
  operator.setToken(login.token);
}

async function checkSnapshotRegistry(fixture: Fixture) {
  const { rows } = await required(
    operator.query("admin.storage.snapshots.list", { tenant }),
  );
  assert.ok(
    rows.some((row) => row.id === fixture.snapshotOperation && row.bytes !== null),
  );
}

async function authorityGeneration(client: Client) {
  const head = await required(client.query("zerotrust.recovery.head", { tenant }));
  return head.generation;
}

async function verifiedSessionToken(client: Client) {
  lastBearer = undefined;
  const status = await required(
    client.query("auth.check", undefined, { strategy: "network-only" }),
  );
  assert.equal(status.success, true);
  if (!lastBearer) throw new Error("Authenticated check sent no bearer");
  return lastBearer;
}

async function rotate(
  reader: Client,
  writer: Client,
  phrase: string,
  password: string,
) {
  const draft = await recoveryDraft(reader, tenant, phrase, password, {
    restoreAdministrator: true,
  });
  const plan = await recoveryPlan(reader, draft);
  await commitRecovery(writer, plan);
  assert.ok(draft.newPhrase !== phrase);
  assert.equal(plan.username, username);
  return draft.newPhrase;
}

async function checkData(client: Client, fixture: Fixture, title: string) {
  const session = await required(client.query("auth.sessionInfo", undefined));
  assert.equal(session.user.id, fixture.administrator);
  assert.deepEqual(session.roles, [":admin"]);
  const business = openBusiness(client);
  try {
    const project = await required(
      business.query("projects.get", { id: fixture.project }),
    );
    assert.equal(project.title, title);
    const files = await required(
      business.query("projects.files.list", { projectId: fixture.project }),
    );
    assert.ok(
      files.some((file) => file.id === fixture.file && file.fileName === fileName),
    );
    const contents = await business.files.blob(fixture.project, fixture.file);
    assert.deepEqual(new Uint8Array(await contents.arrayBuffer()), fileBytes);
  } finally {
    business.dispose();
  }
}

async function renameProject(client: Client, project: string, title: string) {
  const business = openBusiness(client);
  try {
    await required(
      business.mutate("projects.update", { id: project, data: { title } }),
    );
  } finally {
    business.dispose();
  }
}

async function prepareSource() {
  await signInOperator();
  const setup = await tenantSetupRequest(tenant);
  await required(operator.mutate("admin.tenants.create", setup.request));
  const draft = await prepareOwner(first, setup.link, username, originalPassword);
  await commitOwner(first, draft);
  await initializeTenant(first, signal, duckDriver);
  assert.equal(await authorityGeneration(second), "1");

  const business = openBusiness(first);
  let project: string;
  let file: string;
  try {
    const created = await required(
      business.mutate("projects.create", { title: originalTitle }),
    );
    project = created.id;
    file = await business.files.upload({
      projectId: project,
      name: fileName,
      mime: "text/plain",
      blob: new Blob([fileBytes]),
    });
  } finally {
    business.dispose();
  }
  const retiredToken = await verifiedSessionToken(first);
  const operation = crypto.randomUUID();
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", { tenant, operation }),
  );
  const download = await operator.resource(
    `/operator/snapshots/${tenant}/${operation}`,
  );
  assert.equal(download.status, 200);
  const previous = Buffer.from(await download.arrayBuffer());
  assert.equal(previous.length, snapshot.bytes);
  for (const value of [draft.phrase, originalPassword, originalTitle, fileName])
    assert.ok(!previous.includes(value));
  assert.ok(!previous.includes(Buffer.from(fileBytes)));
  await writeFile(join(root, "retired-tenant.duckdb"), previous, {
    mode: 0o600,
    flag: "wx",
  });
  console.log("Created and downloaded the encrypted generation-one tenant snapshot");

  first.setToken(null);
  await lockCryptoSession();
  const currentPhrase = await rotate(first, second, draft.phrase, currentPassword);
  assert.equal(await authorityGeneration(first), "2");
  await signIn(second, { tenant, username, password: currentPassword });
  await renameProject(second, project, currentTitle);
  const currentToken = await verifiedSessionToken(second);
  const fixture: Fixture = {
    administrator: draft.userId,
    snapshotOperation: operation,
    project,
    file,
    retiredPhrase: draft.phrase,
    currentPhrase,
    retiredToken,
    currentToken,
  };
  await checkData(second, fixture, currentTitle);
  if (officeRestore) {
    const editor = openBusiness(second);
    try {
      fixture.officeRooms = await officeRestore.prepareOfficeRooms(
        editor.files,
        project,
      );
    } finally {
      editor.dispose();
    }
  }
  // Include a second usable tenant in the same physical datastore. A blocked
  // file must not prevent this tenant from being listed or signing in.
  const other = await tenantSetupRequest(otherTenant);
  await required(operator.mutate("admin.tenants.create", other.request));
  const otherDraft = await prepareOwner(first, other.link, username, otherPassword);
  await commitOwner(first, otherDraft);
  await initializeTenant(first, signal, duckDriver);
  await writeFile(fixturePath, JSON.stringify(fixture), {
    mode: 0o600,
    flag: "wx",
  });
}

async function rejectStaleFiles(fixture: Fixture) {
  const rows = await required(operator.query("admin.tenants.list", undefined));
  const blocked = rows.find((row) => row.name === tenant);
  assert.equal(blocked?.availability, "unavailable");
  assert.ok(blocked && !("ownerRegistered" in blocked));
  const intact = rows.find((row) => row.name === otherTenant);
  assert.ok(intact?.availability === "available" && intact.ownerRegistered);
  const [details, detailError] = await operator.query("admin.tenants.get", {
    name: tenant,
  });
  assert.equal(details, null);
  assert.equal(detailError?.data?.httpCode, 503);
  const [unlock, unlockError] = await operator.mutate("admin.tenants.unlock", {
    name: tenant,
  });
  assert.equal(unlock, null);
  assert.ok(unlockError instanceof RpcClientError);
  assert.equal(unlockError.data?.httpCode, 503);
  const download = await operator.resource(
    `/operator/snapshots/${tenant}/${fixture.snapshotOperation}`,
  );
  assert.equal(download.status, 200);
  const backedUp = await readFile(join(root, "retired-tenant.duckdb"));
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.ok(downloaded.equals(backedUp));
  for (const client of [first, second]) {
    const [head, headError] = await client.query("zerotrust.recovery.head", { tenant });
    assert.equal(head, null);
    assert.equal(headError?.data?.httpCode, 503);
    client.setToken(fixture.retiredToken);
    const [session, sessionError] = await client.query("auth.check", undefined);
    assert.equal(session, null);
    assert.ok(sessionError);
    client.setToken(null);
  }
  await signIn(second, { tenant: otherTenant, username, password: otherPassword });
  await verifiedSessionToken(second);
  console.log(
    "Both fresh API processes blocked the older tenant file. The other tenant and the backup registry remained accessible.",
  );
}

async function useRestoredFiles(fixture: Fixture) {
  const rows = await required(operator.query("admin.tenants.list", undefined));
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) => row.availability === "available" && row.ownerRegistered),
  );
  for (const client of [first, second]) {
    assert.equal(await authorityGeneration(client), "2");
    client.setToken(fixture.retiredToken);
    await assert.rejects(() => verifiedSessionToken(client), { code: "UNAUTHORIZED" });
    client.setToken(fixture.currentToken);
    await verifiedSessionToken(client);
    client.setToken(null);
    await assert.rejects(() =>
      recoveryDraft(client, tenant, fixture.retiredPhrase, nextPassword, {
        restoreAdministrator: true,
      }),
    );
  }
  await assert.rejects(() =>
    signIn(first, { tenant, username, password: originalPassword }),
  );
  await signIn(second, { tenant, username, password: currentPassword });
  await checkData(second, fixture, currentTitle);
  if (officeRestore) {
    assert.ok(fixture.officeRooms?.length === 2);
    const editor = openBusiness(second);
    try {
      await officeRestore.restoreOfficeRooms(
        editor.files,
        fixture.project,
        fixture.officeRooms,
      );
    } finally {
      editor.dispose();
    }
  }
  await renameProject(second, fixture.project, nextTitle);
  second.setToken(null);
  await lockCryptoSession();

  await rotate(second, first, fixture.currentPhrase, nextPassword);
  assert.equal(await authorityGeneration(second), "3");
  await assert.rejects(() =>
    recoveryDraft(second, tenant, fixture.currentPhrase, currentPassword),
  );
  await signIn(first, { tenant, username, password: nextPassword });
  await checkData(first, fixture, nextTitle);
  if (officeRestore) {
    assert.ok(fixture.officeRooms?.length === 2);
    const editor = openBusiness(first);
    try {
      await officeRestore.checkCommittedOfficeFiles(
        editor.files,
        fixture.project,
        fixture.officeRooms,
      );
    } finally {
      editor.dispose();
    }
  }
  console.log("Reopened encrypted project and file, saved a change, and rotated the phrase again");
}

try {
  if (phase === "source") {
    await prepareSource();
  } else {
    const fixture: Fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    await signInOperator();
    // This registry stays reachable even if the tenant file fails admission.
    await checkSnapshotRegistry(fixture);
    if (phase === "stale") await rejectStaleFiles(fixture);
    else await useRestoredFiles(fixture);
  }
} finally {
  first.setToken(null);
  second.setToken(null);
  operator.setToken(null);
  await lockCryptoSession();
}
