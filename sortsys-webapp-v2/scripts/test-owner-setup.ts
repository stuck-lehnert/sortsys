import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import { base64, randomSecret } from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { exerciseKeyRegistry } from "./test-key-registry";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import {
  commitOwner,
  prepareOwner,
  readTenantSetupLink,
  tenantSetupRequest,
  tenantSetupUrl,
} from "../app/lib/crypto/tenantSetup";
import {
  lockCryptoSession,
  signIn,
  trustedHistory,
} from "../app/lib/crypto/session";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [mode, , outputPath] = process.argv.slice(2);
const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT ?? "new-tenant";
assert.match(tenant, /^[a-z0-9][a-z0-9-]{0,62}$/);
assert.ok(outputPath);
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
type RequestHook = (
  url: URL,
  next: () => Promise<Response>,
) => Promise<Response>;
let requestHook: RequestHook | null = null;
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const rpcTransmissions: string[][] = [];
let rejectOneSetup = false;
let loseOneSetupReply = false;
let committedRequest: Request | null = null;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const [input, options] = args;
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const body = options?.body;
    if (typeof body === "string") requests.push(body);
    if (mode === "owner-tool-batches" && url.searchParams.has("input")) {
      requests.push(url.searchParams.get("input")!);
    }
    if (mode === "owner-staging" && url.searchParams.get("batch") === "1") {
      rpcTransmissions.push(url.pathname.slice(1).split(","));
    }
    if (requestHook)
      return requestHook(url, () => Reflect.apply(target, receiver, args));
    if (url.pathname === "/auth.owner.finish" && loseOneSetupReply) {
      loseOneSetupReply = false;
      // Start on one replica and complete on the other. Losing only the
      // successful response must be resolved through ordinary PAKE sign-in.
      const peerUrl = new URL(url.pathname + url.search, endpoints[0]);
      committedRequest = new Request(peerUrl, options);
      return Reflect.apply(target, receiver, [peerUrl, options]).then(
        async (response: Response) => {
          const reply = await response.json();
          assert.ok(reply[0]?.result?.data?.json?.token);
          throw new TypeError("Simulated connection loss after owner commit");
        },
      );
    }
    if (
      url.pathname === "/auth.owner.finish" &&
      rejectOneSetup &&
      typeof body === "string"
    ) {
      rejectOneSetup = false;
      const changed = JSON.parse(body);
      changed["0"].json.setup.owner.user = "user:someone-else";
      return Reflect.apply(target, receiver, [
        input,
        { ...options, body: JSON.stringify(changed) },
      ]);
    }
    return Reflect.apply(target, receiver, args);
  },
});
const operator = createClient(endpoints[0], "owner-setup-operator");
const owner = createBusinessClient(
  createClient(endpoints[1], "owner-setup-user"),
  { productDriver: duckDriver },
);
const peer = createBusinessClient(
  createClient(endpoints[0], "owner-setup-peer"),
  { productDriver: duckDriver },
);
async function required<T>(promise: Promise<[T | null, Error | null]>) {
  const [value, error] = await promise;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
try {
  const login = await required(
    operator.mutate("admin.login", {
      tenant: null,
      password: "Disposable-operator-password-2026!",
    }),
  );
  operator.setToken(login.token);
  const original = await tenantSetupRequest(tenant);
  const created = await required(
    operator.mutate("admin.tenants.create", original.request),
  );
  assert.equal(created.ownerRegistered, false);
  await required(operator.mutate("admin.tenants.create", original.request));
  await assert.rejects(() =>
    required(
      owner.mutate("auth.owner.inspect", {
        tenant: original.link.tenant,
        secret: base64(randomSecret()),
      }),
    ),
  );
  const replacement = await tenantSetupRequest(tenant);
  await required(
    operator.mutate("admin.tenants.setupLink", replacement.request),
  );
  await assert.rejects(() =>
    required(owner.mutate("auth.owner.inspect", original.link)),
  );
  await required(operator.mutate("admin.tenants.create", original.request));
  await assert.rejects(
    () => required(owner.mutate("auth.owner.inspect", original.link)),
    "an identical create retry must not restore an old setup capability",
  );
  const url = tenantSetupUrl(replacement.link, "http://127.0.0.1:5173");
  assert.equal(new URL(url).search, "");
  assert.deepEqual(readTenantSetupLink(new URL(url).hash), replacement.link);
  const draft = await prepareOwner(
    owner,
    replacement.link,
    "builder",
    "Only-owner-knows-this-password-2026!",
    mode === "owner-backup" || mode === "owner-backup-archive"
      ? {
          userId: "2n",
          context: `backup:${base64(new Uint8Array(32).fill(19))}`,
        }
      : {},
  );
  rejectOneSetup = true;
  await assert.rejects(
    () => commitOwner(owner, draft),
    "a changed public owner must not be registered",
  );
  assert.equal(
    (
      await required(
        operator.query(
          "admin.tenants.get",
          { name: tenant },
          { strategy: "network-only" },
        ),
      )
    ).ownerRegistered,
    false,
  );
  await required(owner.mutate("auth.owner.inspect", replacement.link));
  loseOneSetupReply = true;
  await commitOwner(owner, draft);
  assert.ok(committedRequest);
  const replay = await originalFetch(committedRequest);
  const replayResult = await replay.json();
  assert.equal(replayResult[0]?.error?.json?.data?.code, "UNAUTHORIZED");
  const status = await required(
    owner.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(status.phase, "active");
  assert.equal(status.accessReady, true);
  assert.equal(status.profile?.owner.user, `user:${draft.userId}`);
  const history = await trustedHistory(owner);
  assert.equal(
    history.current.recoverySigningKey,
    draft.setup.authority.recoverySigningKey,
  );
  assert.equal(
    (
      await required(
        operator.query(
          "admin.tenants.get",
          { name: tenant },
          { strategy: "network-only" },
        ),
      )
    ).ownerRegistered,
    true,
  );
  await assert.rejects(
    () =>
      required(operator.mutate("admin.tenants.setupLink", replacement.request)),
    "the provider must not renew initialization after first ownership",
  );
  const conflicting = await tenantSetupRequest(tenant);
  await assert.rejects(() =>
    required(operator.mutate("admin.tenants.create", conflicting.request)),
  );
  await required(operator.mutate("admin.tenants.create", original.request));
  await assert.rejects(() =>
    required(owner.mutate("auth.owner.inspect", replacement.link)),
  );
  await signIn(peer, {
    tenant: tenant,
    username: "builder",
    password: draft.password,
  });
  assert.equal(
    (await trustedHistory(peer)).current.authoritySigningKey,
    draft.setup.authority.authoritySigningKey,
  );
  // The deliberately rejected setup capability above cleared the anonymous
  // setup client's token. Establish its ordinary account session again.
  await signIn(owner, {
    tenant: tenant,
    username: "builder",
    password: draft.password,
  });
  if (mode === "owner-bootstrap") {
    const { exerciseTenantInitialization } =
      await import("./test-tenant-initialization");
    await exerciseTenantInitialization(owner, peer, draft, (hook) => {
      requestHook = hook;
    });
    const { exerciseNativeDelivery } = await import("./test-duckdb-delivery");
    const canaries = await exerciseNativeDelivery(owner, peer);
    const { exerciseNativeBusinessWorkflows } =
      await import("./test-native-business-workflows");
    canaries.push(
      ...(await exerciseNativeBusinessWorkflows(owner, peer, (hook) => {
        requestHook = hook;
      })),
    );
    for (const canary of canaries)
      assert.equal(
        requests.some((body) => body.includes(canary)),
        false,
      );
    process.env.SORTSYS_LLM_TEST_PEER = endpoints[1];
    const { testDocumentMessages } =
      await import("./test-live-document-messages");
    await testDocumentMessages(owner, duckDriver, draft.password);
  } else if (mode === "owner-staging") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseRpcBatching } = await import("./test-batched-reads");
    await exerciseRpcBatching(owner, rpcTransmissions);
    const { exerciseNativeStaging } = await import("./test-native-staging");
    await exerciseNativeStaging(owner, peer, draft);
  } else if (mode === "owner-tool-batches") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativeDomainBatches } =
      await import("./test-native-domain-batches");
    await exerciseNativeDomainBatches(owner, peer);
    const { exerciseToolBookingBatches } =
      await import("./test-tool-booking-batches");
    await exerciseToolBookingBatches(owner, peer, (hook) => {
      requestHook = hook;
    });
  } else if (mode === "owner-backup-archive") {
    const { exerciseBackupArchive } = await import("./test-backup-archive");
    await exerciseBackupArchive(owner, peer, draft);
  } else if (mode === "owner-backup") {
    const { exerciseBackupInitialization } =
      await import("./test-backup-initialization");
    await exerciseBackupInitialization(owner, peer, draft);
  } else if (mode !== "owner-minimal") {
    await exerciseKeyRegistry(owner, peer, draft);
  }
  for (const body of requests) {
    assert.ok(
      !body.includes(draft.password),
      "the user password must stay in the browser",
    );
    assert.ok(
      !body.includes(draft.phrase),
      "the recovery phrase must stay in the browser",
    );
    if (mode === "owner-tool-batches") {
      for (const marker of [
        "Werkzeugausgabe Rohbau",
        "Werkzeugausgabe Ausbau",
        "Sammelausgabe Nordflügel",
        "Sammelausgabe Südflügel",
        "Geschützte Sammelausgabe 751392",
        "1127.25",
        "917.25",
        "11.375",
      ]) {
        assert.equal(
          body.includes(marker),
          false,
          "Tool booking plaintext must stay in the browser: " + marker,
        );
      }
    }
  }
  await writeFile(
    join(dirname(outputPath), "owner-recovery.json"),
    JSON.stringify({ tenant: draft.link.tenant, phrase: draft.phrase }),
    { mode: 0o600 },
  );
  await writeFile(
    outputPath,
    JSON.stringify({
      success: true,
      initialKeysVerified: true,
      capabilityConsumed: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  operator.setToken(null);
  owner.setToken(null);
  peer.setToken(null);
  owner.dispose();
  peer.dispose();
}
