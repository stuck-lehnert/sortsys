import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createClient } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { RestoreAbsenceConflict } from "../app/lib/backups/absenceReview";
import {
  activatePreparedContent,
  approvePreparedContent,
  inspectPreparedContent,
} from "../app/lib/backups/contentRestore";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import {
  absenceCollection,
  absenceRequest,
  type AbsenceDecision,
} from "../app/lib/data/absenceData";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port);
}
const tenant = "absence-restore-tenant";
assert.equal(process.env.SORTSYS_NATIVE_AUTH_TENANT, tenant);
const reportPath = process.argv[4];
assert.ok(reportPath);

const owner = createClient(endpoints[0], "absence-restore-owner");
const peer = createClient(endpoints[1], "absence-restore-peer");
const operator = createClient(endpoints[0], "absence-restore-operator");
const signal = new AbortController().signal;
const credentials = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};

async function prepareBackup() {
  const backup = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: crypto.randomUUID(),
    }),
  );
  const prepared = await required(
    peer.mutate("zerotrust.content.prepare", {
      snapshotOperation: backup.id,
      operation: crypto.randomUUID(),
    }),
  );
  const proposal = await approvePreparedContent(peer, prepared, signal);
  return { id: backup.id, proposal };
}

async function checkBrowser(backup: string) {
  await new Promise<void>((resolve, reject) => {
    const browser = spawn("node", ["scripts/e2e/absenceRestore.browser.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SORTSYS_ABSENCE_RESTORE_USER: credentials.username,
        SORTSYS_ABSENCE_RESTORE_PASSWORD: credentials.password,
        SORTSYS_ABSENCE_RESTORE_BACKUP: backup,
      },
    });
    browser.once("error", reject);
    browser.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Absence recovery browser failed with code ${code}`));
    });
  });
}

let business: ReturnType<typeof createBusinessClient> | undefined;
try {
  const login = await required(operator.mutate("admin.login", {
    tenant: null,
    password: "Disposable-operator-password-2026!",
  }));
  operator.setToken(login.token);
  await signIn(owner, credentials);
  await initializeTenant(owner, signal, duckDriver);
  await signIn(peer, credentials);
  const { user } = await required(peer.query("auth.sessionInfo", undefined));
  business = createBusinessClient(owner, { productDriver: duckDriver });

  async function createApproved(from: string, to: string) {
    const absence = await required(business!.mutate("users.vacations.create", {
      userId: user.id,
      operationId: publicId(newProductRowId()),
      type: "vacation",
      from,
      to,
    }));
    assert.equal(absence.status, "approved");
    return absence.id;
  }

  const confirmed = await createApproved("2026-12-07", "2026-12-11");
  const withdrawn = await createApproved("2026-12-14", "2026-12-18");
  const entries = await required(
    business.query("users.vacations.list", { userId: user.id }),
  );
  const original = entries.find(({ id }) => id === withdrawn);
  assert.ok(original);
  await required(business.mutate("users.vacations.delete", {
    id: withdrawn,
    expectedRevision: original.revision,
  }));

  const { proposal } = await prepareBackup();
  const result = await inspectPreparedContent(peer, proposal, signal);
  assert.deepEqual(result.restoredAbsences, {
    requests: 1,
    decisions: 2,
    withdrawn: 1,
    unchecked: 0,
  });
  await activatePreparedContent(peer, { ...proposal, review: result.review }, signal);
  const restored = await required(
    business.query("users.vacations.list", { userId: user.id }),
  );
  assert.deepEqual(
    restored.map(({ id, status }) => ({ id, status })),
    [{ id: confirmed, status: "approved" }],
  );
  console.log("Accepted backup checked a live decision and a withdrawn original.");

  const requestArea = absenceCollection(user.id);
  const decisionArea = absenceCollection(user.id, true);
  const requests = await protectedCollection(owner, requestArea, signal);
  const decisions = await protectedCollection(owner, decisionArea, signal);
  let invalidWithdrawnBackup: string;
  try {
    await requests.read();
    await decisions.read();
    const template = await requests.get(requestArea.prefix + confirmed);
    const sample = absenceRequest(template.value, template.envelope.object, user.id);
    const rowId = newProductRowId();
    const id = publicId(rowId);
    const object = requestArea.prefix + id;
    const request = await requests.packet(object, {
      ...sample,
      row: { ...sample.row, values: { ...sample.row.values, id: rowId } },
    });
    await requests.write([request], [{
      domain: decisionArea.domain,
      sequence: decisions.snapshot(),
    }]);

    const now = new Date().toISOString();
    const wrongDecision: AbsenceDecision = {
      format: "sortsys-absence-decision-v1",
      userId: user.id,
      id,
      requestSignature: base64(new Uint8Array(64).fill(47)),
      status: "approved",
      denialReason: null,
      decidedByUserId: user.id,
      decidedAt: now,
      modifiedAt: now,
      legacy: null,
    };
    // Public IDs and permissions are valid. Only a recipient can detect the
    // decision's private reference to a different request signature.
    await decisions.write(
      [await decisions.packet(decisionArea.prefix + id, wrongDecision)],
      [{ domain: requestArea.domain, sequence: requests.snapshot() }],
    );
    const invalid = await prepareBackup();
    await assert.rejects(
      () => inspectPreparedContent(peer, invalid.proposal, signal),
      RestoreAbsenceConflict,
    );

    await requests.read();
    const saved = await requests.get(object);
    await requests.write(
      [await requests.tombstone(object, saved.envelope)],
      [{ domain: decisionArea.domain, sequence: decisions.snapshot() }],
    );
    const invalidWithdrawn = await prepareBackup();
    await assert.rejects(
      () => inspectPreparedContent(peer, invalidWithdrawn.proposal, signal),
      RestoreAbsenceConflict,
    );
    invalidWithdrawnBackup = invalidWithdrawn.id;
  } finally {
    requests.close();
    decisions.close();
  }

  console.log("Both mismatched decisions were rejected before signing the review.");
  const checkInBrowser = process.env.SORTSYS_NATIVE_BROWSER === "1";
  if (checkInBrowser) await checkBrowser(invalidWithdrawnBackup);
  await writeFile(reportPath, JSON.stringify({
    success: true,
    checked: result.restoredAbsences,
    invalidDecisionRejected: true,
    invalidWithdrawnDecisionRejected: true,
    checkedInChromium: checkInBrowser,
  }));
} finally {
  business?.dispose();
  for (const client of [owner, peer, operator]) client.setToken(null);
  lockCryptoSession();
}
