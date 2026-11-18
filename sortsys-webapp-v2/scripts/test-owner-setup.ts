import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import { base64, randomSecret } from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { EncryptedChange } from "../app/lib/data/events";
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
  next: (replacement?: URL) => Promise<Response>,
  options?: RequestInit,
) => Promise<Response>;
let requestHook: RequestHook | null = null;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const requests: string[] = [];
const rpcTransmissions: string[][] = [];
let currentRecoveryPhrase: string | undefined;
const isolatedProcesses =
  mode === "owner-bootstrap" && !!process.env.SORTSYS_NATIVE_API_EXECUTABLE;
const apiOrigins = endpoints.map((endpoint) => new URL(endpoint).origin);
const rpcOrigins = new Set<string>();
const eventOrigins = new Set<string>();
const documentWriteOrigins = new Set<string>();
let nextReplica = 0;
let rejectOneSetup = false;
let loseOneSetupReply = false;
let committedRequest: Request | null = null;
if (isolatedProcesses) {
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct(target, args, newTarget) {
      const url = new URL(String(args[0]));
      const httpOrigin = url.origin.replace(/^ws/, "http");
      if (
        url.pathname === "/zerotrust/events" &&
        apiOrigins.includes(httpOrigin)
      ) {
        const destination = new URL(url.pathname + url.search, endpoints[1]);
        eventOrigins.add(destination.origin);
        destination.protocol = "ws:";
        args = [destination.href, ...args.slice(1)];
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const [input, options] = args;
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const transmit = (replacement?: URL, replacementOptions = options) => {
      let destination = replacement ?? url;
      if (isolatedProcesses && apiOrigins.includes(destination.origin)) {
        const paths = destination.pathname.slice(1).split(",");
        if (paths.includes("zerotrust.documents.messages.post")) {
          destination = new URL(
            destination.pathname + destination.search,
            endpoints[0],
          );
          documentWriteOrigins.add(destination.origin);
        } else if (!replacement) {
          destination = new URL(
            destination.pathname + destination.search,
            endpoints[nextReplica++ % endpoints.length],
          );
        }
        rpcOrigins.add(destination.origin);
      }
      let request = input;
      if (destination.href !== url.href) {
        request =
          input instanceof Request
            ? new Request(destination, input)
            : destination;
      }
      return Reflect.apply(target, receiver, [request, replacementOptions]);
    };
    const body = options?.body;
    if (typeof body === "string") requests.push(body);
    if (
      [
        "owner-tool-batches",
        "owner-access-pages",
        "owner-access-publications",
        "owner-planning-recipients",
      ].includes(mode) &&
      url.searchParams.has("input")
    ) {
      requests.push(url.searchParams.get("input")!);
    }
    if (
      [
        "owner-staging",
        "owner-backup-archive",
        "owner-content-preparation",
      ].includes(mode) &&
      url.searchParams.get("batch") === "1"
    ) {
      rpcTransmissions.push(url.pathname.slice(1).split(","));
    }
    if (requestHook)
      return requestHook(url, (replacement) => transmit(replacement), options);
    if (url.pathname === "/auth.owner.finish" && loseOneSetupReply) {
      loseOneSetupReply = false;
      // Start on one replica and complete on the other. Losing only the
      // successful response must be resolved through ordinary PAKE sign-in.
      const peerUrl = new URL(url.pathname + url.search, endpoints[0]);
      committedRequest = new Request(peerUrl, options);
      return transmit(peerUrl).then(async (response: Response) => {
        const reply = await response.json();
        assert.ok(reply[0]?.result?.data?.json?.token);
        throw new TypeError("Simulated connection loss after owner commit");
      });
    }
    if (
      url.pathname === "/auth.owner.finish" &&
      rejectOneSetup &&
      typeof body === "string"
    ) {
      rejectOneSetup = false;
      const changed = JSON.parse(body);
      changed["0"].json.setup.owner.user = "user:someone-else";
      return transmit(undefined, { ...options, body: JSON.stringify(changed) });
    }
    return transmit();
  },
});
const operator = createClient(endpoints[0], "owner-setup-operator");
const gaebProcessor =
  mode === "owner-content-preparation" || mode === "owner-staging"
    ? (await import("./lib/gaebProcessor")).cliGaebProcessor
    : undefined;
const owner = createBusinessClient(
  createClient(endpoints[1], "owner-setup-user"),
  { productDriver: duckDriver, gaebProcessor },
);
const contentChanges: EncryptedChange[] = [];
const peer = createBusinessClient(
  createClient(endpoints[0], "owner-setup-peer"),
  {
    productDriver: duckDriver,
    gaebProcessor,
    endpoint: endpoints[0],
    realtime: mode === "owner-content-preparation",
    onRemoteChange:
      mode === "owner-content-preparation"
        ? (change) => contentChanges.push(change)
        : undefined,
  },
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
  if (mode === "owner-content-preparation") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseContentPreparation } =
      await import("./test-native-content-preparation");
    const probeEndpoint = endpoints[0];
    function operatorProbe() {
      const probe = createClient(
        probeEndpoint,
        `restore-probe-${crypto.randomUUID()}`,
      );
      probe.setToken(login.token);
      return probe;
    }
    await exerciseContentPreparation(
      owner,
      peer,
      operator,
      operatorProbe,
      tenant,
      dirname(outputPath),
      contentChanges,
      { username: draft.username, password: draft.password },
      createClient(endpoints[0], "owner-restore-tool-member"),
      rpcTransmissions,
    );
  } else if (mode === "owner-bootstrap") {
    const { exerciseTenantInitialization } =
      await import("./test-tenant-initialization");
    await exerciseTenantInitialization(owner, peer, draft, (hook) => {
      requestHook = hook;
    });
    const { exerciseNativeDelivery } = await import("./test-duckdb-delivery");
    const canaries = await exerciseNativeDelivery(owner, peer, (hook) => {
      requestHook = hook;
    });
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
  } else if (mode === "owner-planning-recipients") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativePlanningRecipients } =
      await import("./test-native-planning-recipients");
    const scenario = await exerciseNativePlanningRecipients(owner, peer);
    const { exercisePlanningRecovery } =
      await import("./test-native-planning-recovery");
    const recovered = await exercisePlanningRecovery(
      owner,
      peer,
      scenario,
      draft.phrase,
    );
    currentRecoveryPhrase = recovered.phrase;
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      const { exercisePlanningBrowser } =
        await import("./test-planning-browser");
      await exercisePlanningBrowser(owner, recovered.owner, {
        ...scenario,
        member: recovered.member,
      });
    }
  } else if (mode === "owner-print-templates") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativePrintTemplates } =
      await import("./test-native-print-templates");
    currentRecoveryPhrase = await exerciseNativePrintTemplates(
      owner,
      peer,
      draft,
    );
  } else if (mode === "owner-staging") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseRpcBatching } = await import("./test-batched-reads");
    await exerciseRpcBatching(owner, rpcTransmissions);
    const { exerciseNativeStaging } = await import("./test-native-staging");
    await exerciseNativeStaging(owner, peer, draft, rpcTransmissions);
    const { exerciseNativeStockBatching } =
      await import("./test-native-stock-batching");
    await exerciseNativeStockBatching(owner, peer, rpcTransmissions);
    const { exerciseGaebCaseBatches } =
      await import("./test-native-content-preparation");
    await exerciseGaebCaseBatches(owner, peer, rpcTransmissions);
  } else if (mode === "owner-access-publications") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativeAccessPublications } =
      await import("./test-native-access-publications");
    await exerciseNativeAccessPublications(owner, peer, (hook) => {
      requestHook = hook;
    });
  } else if (mode === "owner-access-pages") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativeAccessPages } =
      await import("./test-native-access-pages");
    await exerciseNativeAccessPages(owner, peer, endpoints, (hook) => {
      requestHook = hook;
    });
  } else if (mode === "owner-tool-batches") {
    const { initializeTenant } =
      await import("../app/lib/crypto/initializeTenant");
    await initializeTenant(owner, new AbortController().signal, duckDriver);
    const { exerciseNativeDomainBatches } =
      await import("./test-native-domain-batches");
    await exerciseNativeDomainBatches(owner, peer);
    const { exerciseInitialRecordRevocation } =
      await import("./test-initial-record-revocation");
    await exerciseInitialRecordRevocation(owner, peer);
    const { exerciseToolBookingBatches } =
      await import("./test-tool-booking-batches");
    await exerciseToolBookingBatches(owner, peer, (hook) => {
      requestHook = hook;
    });
    const { exerciseLateToolResponsibility } =
      await import("./test-native-late-tool-responsibility");
    await exerciseLateToolResponsibility(owner, peer);
  } else if (mode === "owner-backup-archive") {
    const { exerciseBackupArchive } = await import("./test-backup-archive");
    await exerciseBackupArchive(owner, peer, draft, rpcTransmissions);
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
        "First authorized publication",
        "Must remain unpublished after revocation",
        "Existing resource remains editable",
        "Werkzeugausgabe Rohbau",
        "Werkzeugausgabe Ausbau",
        "Sammelausgabe Nordflügel",
        "Sammelausgabe Südflügel",
        "Geschützte Sammelausgabe 751392",
        "1127.25",
        "917.25",
        "11.375",
        "Privater Werkzeugbestand 571943",
        "Vertrauliche Ausgabe vor der Registrierung",
        "Private Ergänzung nach der Rückgabe 681527",
        "1479.25",
        "23.875",
      ]) {
        assert.equal(
          body.includes(marker),
          false,
          "Tool booking plaintext must stay in the browser: " + marker,
        );
      }
    }
    if (mode === "owner-access-publications") {
      assert.equal(
        body.includes("Private batched permission record 591274"),
        false,
      );
    }
    if (mode === "owner-access-pages") {
      assert.equal(
        body.includes("Private page inventory fixture 861329"),
        false,
      );
    }
    if (mode === "owner-planning-recipients") {
      for (const privateValue of [
        "Private own planning 816294",
        "Other person's private planning 749281",
        "Updated private own planning 163829",
        "Private Baustelle 647823",
        "Zielbaustelle 381694",
      ])
        assert.equal(
          body.includes(privateValue),
          false,
          "Planning contents must remain encrypted on the native transport",
        );
    }
    if (mode === "owner-backup-archive") {
      for (const marker of [
        "Private Werkzeugdaten 651297",
        "1287.25",
        "11.625",
        "Private Lieferung 486219",
        "Private old credential 219453",
        "Other tenant secret 742963",
        "Private scan error 739182",
        "invalid original result 619243",
      ]) {
        assert.equal(
          body.includes(marker),
          false,
          "Adopted tool contents must remain client-encrypted",
        );
      }
    }
  }
  await writeFile(
    join(dirname(outputPath), "owner-recovery.json"),
    JSON.stringify({
      tenant: draft.link.tenant,
      phrase: currentRecoveryPhrase ?? draft.phrase,
    }),
    { mode: 0o600 },
  );
  if (isolatedProcesses) {
    assert.deepEqual([...rpcOrigins].sort(), [...apiOrigins].sort());
    assert.deepEqual([...eventOrigins], [apiOrigins[1]]);
    assert.deepEqual([...documentWriteOrigins], [apiOrigins[0]]);
    await writeFile(
      join(dirname(outputPath), "api-process-traffic.json"),
      JSON.stringify({
        ordinaryRequestsAlternated: true,
        rpcOrigins: [...rpcOrigins],
        eventOrigins: [...eventOrigins],
        documentWriteOrigins: [...documentWriteOrigins],
      }),
    );
  }
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
  globalThis.WebSocket = originalWebSocket;
  await lockCryptoSession();
  operator.setToken(null);
  owner.setToken(null);
  peer.setToken(null);
  owner.dispose();
  peer.dispose();
}
