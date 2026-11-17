import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

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
const mode = process.argv[2];
const tenant = "passkey-tenant-a";
const client = createClient(endpoints[0], "passkey-account-lifecycle");
const signal = new AbortController().signal;
try {
  if (mode === "rename") {
    await signIn(client, {
      tenant,
      username: "builder",
      password: "Passkey-preserved-password-2026!",
    });
    await initializeTenant(client, signal, duckDriver);
    const session = await required(client.query("auth.sessionInfo", undefined));
    const business = createBusinessClient(client, {
      productDriver: duckDriver,
    });
    try {
      await required(
        business.mutate("users.update", {
          id: session.user.id,
          data: { username: "builder-updated" },
        }),
      );
    } finally {
      business.dispose();
    }
    process.stdout.write(
      JSON.stringify({ success: true, username: "builder-updated" }) + "\n",
    );
  } else if (mode === "recover") {
    const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
    assert.ok(
      typeof root === "string" &&
        isAbsolute(root) &&
        basename(root).startsWith("sortsys-native-auth-"),
    );
    const source = JSON.parse(
      await readFile(join(root, "passkey-recovery-source.json"), "utf8"),
    );
    assert.equal(source.tenant, tenant);
    const draft = await recoveryDraft(
      client,
      tenant,
      source.phrase,
      "Recovered-passkey-test-password-2026!",
    );
    const plan = await recoveryPlan(client, draft);
    await commitRecovery(client, plan);
    await signIn(client, {
      tenant,
      username: plan.username,
      password: draft.password,
    });
    process.stdout.write(
      JSON.stringify({ success: true, username: plan.username }) + "\n",
    );
  } else throw new Error("Unknown native passkey lifecycle step");
} finally {
  client.setToken(null);
  await lockCryptoSession();
}
