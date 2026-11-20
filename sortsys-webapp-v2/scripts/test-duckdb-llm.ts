import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { required } from "../app/lib/data/protectedObjects";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitOwner,
  prepareOwner,
  tenantSetupRequest,
} from "../app/lib/crypto/tenantSetup";
import { lockCryptoSession } from "../app/lib/crypto/session";
import { testLiveLlm } from "./test-live-llm";

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
const administrator = createClient(endpoints[0], "native-model-administrator");
const transport = createClient(endpoints[0], "native-model-owner");
let ownerToken: string | null = null;
const owner: Client = {
  ...transport,
  mutate: (async (path, input, options) => {
    const reply = await transport.mutate(path, input, options);
    if (path === "auth.owner.finish" && reply[0]) {
      ownerToken = (reply[0] as { token: string }).token;
    }
    return reply;
  }) as Client["mutate"],
};
const adminPassword = "Native-model-operator-password-2026!";
const ownerName = "builder";
const ownerPassword = "Native-model-owner-password-2026!";
const signal = new AbortController().signal;
let business: ReturnType<typeof createBusinessClient> | null = null;
try {
  const admin = await required(
    administrator.mutate("admin.login", {
      tenant: null,
      password: adminPassword,
    }),
  );
  administrator.setToken(admin.token);
  const { request, link } = await tenantSetupRequest("llm-tenant");
  await required(administrator.mutate("admin.tenants.create", request));
  const draft = await prepareOwner(
    owner,
    link,
    ownerName,
    ownerPassword,
  );
  await commitOwner(owner, draft);
  await initializeTenant(owner, signal, duckDriver);
  assert.equal(
    (await required(owner.query("llm.status", undefined))).tenantEnabled,
    false,
  );
  assert.ok(ownerToken);
  // Inspect the rejection without the SDK's automatic session logout on 401.
  const deniedUrl = new URL("admin.llm.providers.list", endpoints[0]);
  deniedUrl.searchParams.set("batch", "1");
  deniedUrl.searchParams.set("input", JSON.stringify({ "0": { json: null } }));
  const denied = await fetch(deniedUrl, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const rejection = await denied.json();
  assert.equal(
    rejection[0]?.error?.json?.data?.httpCode,
    401,
    "a tenant administrator cannot read operator credentials",
  );
  business = createBusinessClient(owner, {
    endpoint: endpoints[1],
    productDriver: duckDriver,
  });
  await required(
    business.mutate("products.create", {
      customId: 1,
      name: "Bogenberechnung Fensterlaibung",
      description: "Ansatz für einen Bogen über der Fensteröffnung",
      baseUnit: "m²",
      otherUnits: {},
    }),
  );
  await testLiveLlm(owner, business, duckDriver, {
    endpoint: endpoints[0],
    ownerEndpoint: endpoints[1],
    peerEndpoint: endpoints[0],
    adminPassword,
    ownerToken,
    ownerLogin: { username: `${ownerName}@${link.tenant}`, password: ownerPassword },
  });
  const rows = await required(
    administrator.query("admin.llm.usage", undefined, {
      strategy: "network-only",
    }),
  );
  const status = await required(
    owner.query("llm.status", undefined, { strategy: "network-only" }),
  );
  const total = rows
    .filter((row) => row.tenant === link.tenant)
    .reduce((sum, row) => sum + row.totalTokens, 0n);
  assert.ok(total > 60n);
  assert.equal(status.usedTokens, total);
  await required(
    administrator.mutate("admin.llm.tenants.update", {
      name: link.tenant,
      enabled: true,
      monthlyTokenQuota: total,
    }),
  );
  assert.equal(
    (
      await required(
        owner.query("llm.status", undefined, { strategy: "network-only" }),
      )
    ).available,
    false,
  );
  assert.ok(
    (
      await owner.mutate("zerotrust.llm.open", {
        kind: "chat",
        chatId: "1",
        queries: [],
        mutations: [],
      })
    )[1],
  );
  console.log(
    "Native LLM verified: shared operator configuration, authenticated cross-instance MCP, encrypted browser history, live originals, proposal approval, cancellation, replay protection and shared token quota.",
  );
} finally {
  business?.dispose();
  administrator.setToken(null);
  owner.setToken(null);
  await lockCryptoSession();
}
