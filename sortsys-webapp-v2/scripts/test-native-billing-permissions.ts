import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createClient } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { testBillingPermissions } from "./test-live-billing-permissions";

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
const [, , output] = process.argv.slice(2);
assert.ok(output);
const client = createClient(endpoints[0], "native-billing-owner");
process.env.SORTSYS_LLM_TEST_PEER = endpoints[1];
try {
  await signIn(client, {
    tenant: "billing-permissions-tenant",
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  await initializeTenant(client, new AbortController().signal, duckDriver);
  const business = createBusinessClient(client, { productDriver: duckDriver });
  try {
    await required(
      business.mutate("users.create", {
        username: "worker.native",
        firstName: "Rechnungsprüfung",
        contractType: "internal",
      }),
    );
  } finally {
    business.dispose();
  }
  await testBillingPermissions(client, duckDriver);
  await writeFile(
    output,
    JSON.stringify({ success: true, partialInvoiceIssued: true }),
  );
} finally {
  client.setToken(null);
  await lockCryptoSession();
}
