import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClient,
  RpcClientError,
  type Client,
  type MutateInput,
  type MutateResult,
} from "@sortsys/v2-client";
import {
  base64,
  createRecoveryPhrase,
  preparePayload,
  MAX_PAYLOAD_PART_BYTES,
  recoveryIdentity,
  recoveryTransitionFrame,
  sign,
} from "@sortsys/zerotrust/sortsys";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";
import {
  lockCryptoSession,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  newAssistantId,
  openPrivateLlm,
  preparePrivateLlm,
} from "../app/lib/data/privateLlm";
import { required } from "../app/lib/data/protectedObjects";
import {
  initializeTenant,
  verifyTenantInitialized,
} from "../app/lib/crypto/initializeTenant";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import {
  prepareNativeToolRecovery,
  verifyNativeToolRecovery,
} from "./test-native-tool-recovery";
import {
  approveMemberInvitation,
  createMemberInvitation,
  invitationMembers,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";

async function verifyFormerAdministrator(
  administrator: Client,
  formerAdministrator: Client,
  person: { id: string; username: string },
  login: { tenant: string; username: string; password: string },
  password: string,
  signal: AbortSignal,
) {
  console.log(
    "Native recovery: reapproving a former administrator as an ordinary member",
  );
  const current = await required(
    administrator.query("auth.sessionInfo", undefined),
  );
  const history = await trustedHistory(administrator);
  await required(
    administrator.mutate(
      "zerotrust.identities.certify",
      history.identityCertificate(`user:${current.user.id}`),
    ),
  );
  assert.ok(
    (
      await required(administrator.query("auth.sessionInfo", undefined))
    ).roles.includes(":admin"),
    "Renewing the current identity must preserve its explicitly assigned role",
  );
  const previous = (await invitationMembers(administrator, signal)).find(
    (member) => member.id === person.id,
  );
  assert.ok(previous);
  assert.equal(previous.certified, false);
  assert.ok(previous.roles.includes(":admin"));
  const invitation = await createMemberInvitation(
    administrator,
    person,
    {
      catalogue: "none",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    signal,
  );
  await signInMemberInvitation(
    formerAdministrator,
    invitation.link,
    password,
    signal,
  );
  await joinMemberInvitation(formerAdministrator, invitation.link, signal);
  await signIn(administrator, login);
  await approveMemberInvitation(
    administrator,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(formerAdministrator, {
    tenant: login.tenant,
    username: person.username,
    password,
  });
  const member = await required(
    formerAdministrator.query("auth.sessionInfo", undefined),
  );
  assert.deepEqual(
    member.roles,
    [],
    "Reapproval must not revive roles from the previous authority",
  );
  const [directory, denied] = await formerAdministrator.query(
    "zerotrust.members.list",
    { after: null },
    { strategy: "network-only" },
  );
  assert.equal(directory, null);
  assert.ok(denied instanceof RpcClientError);
  assert.equal(denied.code, "FORBIDDEN");
  await signIn(administrator, login);
}

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [, , outputPath] = process.argv.slice(2);
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
const source: { tenant: string; phrase: string } = JSON.parse(
  await readFile(join(dirname(outputPath), "owner-recovery.json"), "utf8"),
);
const signal = new AbortController().signal;
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const requestPaths = new Set<string>();
let lostReply = false;
let loseNextCommitReply = false;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") requests.push(args[1].body);
    const url = new URL(
      typeof args[0] === "string" || args[0] instanceof URL
        ? args[0]
        : args[0].url,
    );
    const paths = url.pathname.slice(1).split(",");
    for (const path of paths) requestPaths.add(`/${path}`);
    return Reflect.apply(target, receiver, args).then(
      async (response: Response) => {
        if (
          paths.includes("zerotrust.recovery.commit") &&
          loseNextCommitReply
        ) {
          const reply = await response.clone().json();
          if (reply[paths.indexOf("zerotrust.recovery.commit")]?.result) {
            loseNextCommitReply = false;
            lostReply = true;
            throw new TypeError(
              "Connection lost after the atomic recovery commit",
            );
          }
        }
        return response;
      },
    );
  },
});
const owner = createClient(endpoints[0], "native-recovery-former-owner");
const first = createClient(endpoints[1], "native-recovery-first");
const second = createClient(endpoints[0], "native-recovery-second");
const toolMember = createClient(endpoints[1], "native-recovery-tool-member");
const phrases = [source.phrase];
const passwords = [
  "Native-recovery-password-one-2026!",
  "Native-recovery-password-two-2026!",
];
const originalPassword = "Only-owner-knows-this-password-2026!";
try {
  await signIn(owner, {
    tenant: source.tenant,
    username: "builder",
    password: originalPassword,
  });
  const original = unlockedAccount()!;
  const session = await required(owner.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  const originalCompletion = await initializeTenant(owner, signal, duckDriver);
  const toolRecovery = await prepareNativeToolRecovery(owner, toolMember, {
    tenant: source.tenant,
    username: "builder",
    password: originalPassword,
  });
  // More than 64 keys exercises the server's inventory pagination and the
  // encrypted catalogue tree through its actual read/write endpoints.
  await provisionOwnedCollections(
    owner,
    subject,
    Array.from({ length: 72 }, (_, index) => {
      const scope = `test:recovery:${String(index).padStart(3, "0")}`;
      return {
        domain: `${scope}:master-data`,
        scope,
        facet: "master-data" as const,
        prefix: "canary:",
      };
    }),
    signal,
  );
  const canaryId = newAssistantId();
  const canary = "Vertrauliche Wiederherstellungsnotiz 482731";
  await preparePrivateLlm(owner, subject, signal);
  const personal = await openPrivateLlm(owner, signal);
  try {
    await personal.save("chat", canaryId, { text: canary });
  } finally {
    personal.close();
  }
  const draft = await recoveryDraft(
    first,
    source.tenant,
    source.phrase,
    passwords[0],
  );
  phrases.push(draft.newPhrase);
  const competingDraft = await recoveryDraft(
    second,
    source.tenant,
    source.phrase,
    passwords[0],
  );
  phrases.push(competingDraft.newPhrase);
  console.log("Native recovery: preparing two independently authorized plans");
  const plan = await recoveryPlan(first, draft);
  const competing = await recoveryPlan(second, competingDraft);
  assert.ok(plan.oldKeyEnvelopes.length > 64);
  const altered: MutateInput<"zerotrust.recovery.begin"> =
    structuredClone(plan);
  altered.domains = [];
  assert.ok((await first.mutate("zerotrust.recovery.begin", altered))[1]);
  const before = await required(
    first.query(
      "zerotrust.recovery.head",
      { tenant: source.tenant },
      { strategy: "network-only" },
    ),
  );
  assert.equal(before.generation, "1");
  function transfer(candidate: typeof plan) {
    return {
      // Identical legal JSON whitespace parts exercise deduplicated storage
      // reads while the manifest retains their order and full multiplicity.
      ...preparePayload(
        " ".repeat(MAX_PAYLOAD_PART_BYTES * 2) + JSON.stringify(candidate),
        {
          context: candidate.transition.tenant,
          operation: candidate.transition.operation,
        },
      ),
      authorization: {
        challengeId: candidate.challengeId,
        sourceAuthority: candidate.sourceAuthority,
        transition: candidate.transition,
        proof: candidate.proof,
      },
    };
  }
  // Simulate an incomplete source listing. The normal framework signs a fully
  // coherent plan for that subset, so public signatures alone cannot reject it.
  const omitted = "test:recovery:071:master-data";
  let omittedDomains = 0;
  let omittedKeys = 0;
  const incompleteSource: Client = {
    ...first,
    mutate: (async (path, input, options) => {
      const reply = await first.mutate(path, input, options);
      if (path !== "zerotrust.recovery.page" || reply[1] || reply[0] === null)
        return reply;
      const page = structuredClone(
        reply[0] as MutateResult<"zerotrust.recovery.page">,
      );
      page.items = page.items.filter((item) => {
        if (item.value.id !== omitted) return true;
        if (item.kind === "domain") omittedDomains++;
        else omittedKeys++;
        return false;
      });
      return [page, null];
    }) as Client["mutate"],
  };
  const partialPlan = await recoveryPlan(incompleteSource, draft);
  assert.equal(omittedDomains, 1);
  assert.ok(omittedKeys > 0);
  assert.equal(partialPlan.domains.length, plan.domains.length - 1);
  assert.equal(
    partialPlan.domains.some((domain) => domain.id === omitted),
    false,
  );
  const partialTransfer = transfer(partialPlan);
  await mapConcurrent(partialTransfer.parts, 4, async (content, index) => {
    const endpoint = index % 2 === 0 ? first : second;
    await required(
      endpoint.mutate("zerotrust.recovery.stage", {
        authorization: partialTransfer.authorization,
        manifest: partialTransfer.manifest,
        content,
      }),
    );
  });
  const [partialResult, partialError] = await second.mutate(
    "zerotrust.recovery.commit",
    {
      authorization: partialTransfer.authorization,
      manifest: partialTransfer.manifest,
    },
  );
  assert.equal(partialResult, null);
  assert.ok(partialError instanceof RpcClientError);
  assert.equal(
    partialError?.code,
    "CONFLICT",
    "Valid signatures must reach the storage-side inventory coverage check, which rejects an omitted area",
  );
  const transfers = [plan, competing].map(transfer);
  assert.equal(
    transfers[0]!.manifest.parts[0],
    transfers[0]!.manifest.parts[1],
  );
  assert.ok(
    transfers[0]!.parts.length > 1,
    "The actual recovery inventory must span multiple upload parts",
  );
  const firstPart = {
    authorization: transfers[0]!.authorization,
    manifest: transfers[0]!.manifest,
    content: transfers[0]!.parts[0]!,
  };
  for (const invalid of [
    { ...firstPart, content: firstPart.content + "altered" },
    {
      ...firstPart,
      authorization: {
        ...firstPart.authorization,
        proof: base64(new Uint8Array(64)),
      },
    },
    {
      ...firstPart,
      manifest: { ...firstPart.manifest, context: "unrelated-tenant" },
    },
    { ...firstPart, manifest: transfers[1]!.manifest },
  ]) {
    assert.ok((await first.mutate("zerotrust.recovery.stage", invalid))[1]);
  }
  const stagedPart = await required(
    first.mutate("zerotrust.recovery.stage", firstPart),
  );
  assert.equal(stagedPart.hash, firstPart.manifest.parts[0]);
  assert.equal(
    (await required(second.mutate("zerotrust.recovery.stage", firstPart))).hash,
    stagedPart.hash,
  );
  const secondOperation = structuredClone(firstPart);
  secondOperation.authorization.transition.operation = crypto.randomUUID();
  secondOperation.manifest.operation =
    secondOperation.authorization.transition.operation;
  const uploadSeed = await recoveryIdentity(source.phrase, source.tenant, "1");
  secondOperation.authorization.proof = await sign(
    uploadSeed.signingKey.privateKey,
    recoveryTransitionFrame(secondOperation.authorization.transition),
  );
  const [, secondUpload] = await second.mutate(
    "zerotrust.recovery.stage",
    secondOperation,
  );
  assert.ok(secondUpload instanceof RpcClientError);
  assert.equal(
    secondUpload?.code,
    "CONFLICT",
    "One challenge cannot allocate a second manifest, even with another valid seed authorization",
  );
  assert.ok(
    (
      await second.mutate("zerotrust.recovery.commit", {
        authorization: firstPart.authorization,
        manifest: firstPart.manifest,
      })
    )[1],
    "A partial upload cannot activate any part of the recovery",
  );
  assert.ok(
    (
      await second.mutate("zerotrust.recovery.stage", {
        ...firstPart,
        manifest: { ...firstPart.manifest, hash: "0".repeat(64) },
      })
    )[1],
    "An operation cannot switch to a different manifest after its first part",
  );
  assert.equal(
    (
      await required(
        first.query(
          "zerotrust.recovery.head",
          { tenant: source.tenant },
          { strategy: "network-only" },
        ),
      )
    ).generation,
    "1",
  );
  const uploads = transfers.flatMap((transfer) =>
    transfer.parts.map((content) => ({
      authorization: transfer.authorization,
      manifest: transfer.manifest,
      content,
    })),
  );
  await mapConcurrent(uploads, 4, async (upload, index) => {
    const endpoint = index % 2 === 0 ? first : second;
    const receipt = await required(
      endpoint.mutate("zerotrust.recovery.stage", upload),
    );
    assert.ok(upload.manifest.parts.includes(receipt.hash));
  });
  console.log(
    "Native recovery: signed multi-part uploads remain invisible, repeat across replicas and reject foreign, unsigned, incomplete or substituted manifests",
  );
  console.log("Native recovery: competing commits on separate API replicas");
  const races = await Promise.all([
    first.mutate("zerotrust.recovery.commit", {
      authorization: transfers[0]!.authorization,
      manifest: transfers[0]!.manifest,
    }),
    second.mutate("zerotrust.recovery.commit", {
      authorization: transfers[1]!.authorization,
      manifest: transfers[1]!.manifest,
    }),
  ]);
  assert.equal(races.filter(([, error]) => !error).length, 1);
  const wonFirst = races[0][1] === null;
  const winner = wonFirst ? plan : competing;
  const winnerPhrase = wonFirst ? draft.newPhrase : competingDraft.newPhrase;
  const client: Client = wonFirst ? first : second;
  assert.ok(
    (await second.mutate("zerotrust.recovery.stage", firstPart))[1],
    "The old seed proof cannot upload new parts after activation",
  );
  await required(client.mutate("zerotrust.recovery.begin", winner));
  await required(
    client.mutate("zerotrust.recovery.resume", {
      tenant: source.tenant,
      operation: winner.transition.operation,
    }),
  );
  assert.ok(
    (
      await owner.query("auth.check", undefined, { strategy: "network-only" })
    )[1],
  );
  await assert.rejects(() =>
    recoveryDraft(first, source.tenant, source.phrase, passwords[0]),
  );
  await assert.rejects(() =>
    recoveryDraft(first, source.tenant, createRecoveryPhrase(), passwords[0]),
  );
  await signIn(client, {
    tenant: source.tenant,
    username: winner.username,
    password: passwords[0],
  });
  assert.equal((await trustedHistory(client)).current.generation, "2");
  const incomplete = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(incomplete.initialization, null);
  assert.equal(incomplete.canInitialize, true);
  await assert.rejects(() =>
    verifyTenantInitialized(client, {
      ...incomplete,
      initialization: originalCompletion,
    }),
  );
  const completion = await initializeTenant(client, signal, duckDriver);
  assert.equal(completion.generation, "2");
  const recoveredBusiness = createBusinessClient(client, {
    productDriver: duckDriver,
  });
  const projectTitle = "Nach Wiederherstellung eingerichtete Baustelle 836291";
  const project = await required(
    recoveredBusiness.mutate("projects.create", { title: projectTitle }),
  );
  recoveredBusiness.dispose();
  const currentIdentities = await required(
    client.query("zerotrust.identities.list", undefined),
  );
  assert.deepEqual(
    currentIdentities.map((identity) => identity.subject),
    [winner.transition.nextAdministrator],
  );
  await verifyNativeToolRecovery(
    client,
    toolRecovery,
    {
      tenant: source.tenant,
      username: winner.username,
      password: passwords[0],
    },
    true,
  );
  await verifyFormerAdministrator(
    client,
    owner,
    session.user,
    {
      tenant: source.tenant,
      username: winner.username,
      password: passwords[0],
    },
    originalPassword,
    signal,
  );
  // The old personal area keeps its original subject after seed recovery.
  const { privateLlmCollection } = await import("../app/lib/data/privateLlm");
  const { protectedCollection } =
    await import("../app/lib/data/protectedObjects");
  async function readCanary(reader: Client) {
    const collection = await protectedCollection(
      reader,
      privateLlmCollection(subject),
      signal,
    );
    try {
      const object = (await collection.read()).find(
        (object) => object.envelope.object === `assistant:chat:${canaryId}`,
      );
      assert.ok(object);
      assert.deepEqual(object.value, {
        format: "sortsys-assistant-v1",
        kind: "chat",
        id: canaryId,
        value: { text: canary },
      });
    } finally {
      collection.close();
    }
  }
  await readCanary(client);
  console.log("Native recovery: recovering again with the replacement phrase");
  const next = await recoveryDraft(
    first,
    source.tenant,
    winnerPhrase,
    passwords[1],
  );
  phrases.push(next.newPhrase);
  const nextPlan = await recoveryPlan(first, next);
  loseNextCommitReply = true;
  await commitRecovery(first, nextPlan);
  assert.equal(lostReply, true);
  await assert.rejects(() =>
    recoveryDraft(second, source.tenant, winnerPhrase, passwords[1]),
  );
  await assert.rejects(() =>
    recoveryDraft(second, source.tenant, source.phrase, passwords[1]),
  );
  await signIn(second, {
    tenant: source.tenant,
    username: nextPlan.username,
    password: passwords[1],
  });
  assert.equal((await trustedHistory(second)).current.generation, "3");
  const nextStatus = await required(
    second.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(nextStatus.initialization, null);
  assert.equal(
    (await initializeTenant(second, signal, duckDriver)).generation,
    "3",
  );
  const nextBusiness = createBusinessClient(second, {
    productDriver: duckDriver,
  });
  const preservedProject = await required(
    nextBusiness.query("projects.get", { id: project.id }),
  );
  assert.equal(preservedProject.title, projectTitle);
  await required(
    nextBusiness.mutate("projects.create", {
      title: "Weitere Baustelle nach erneuter Wiederherstellung",
    }),
  );
  nextBusiness.dispose();
  await verifyNativeToolRecovery(
    second,
    toolRecovery,
    {
      tenant: source.tenant,
      username: nextPlan.username,
      password: passwords[1],
    },
    false,
  );
  await readCanary(second);
  await recoveryDraft(first, source.tenant, next.newPhrase, passwords[1]);
  const wire = requests.join("\n");
  for (const path of [
    "zerotrust.recovery.inspect",
    "zerotrust.recovery.page",
    "zerotrust.recovery.registration",
    "zerotrust.recovery.catalog.read",
    "zerotrust.recovery.catalog.write",
    "zerotrust.recovery.begin",
    "auth.opaque.loginStart",
    "auth.opaque.loginFinish",
  ]) {
    assert.ok(
      requestPaths.has(`/${path}`),
      `Missing wire observation for ${path}`,
    );
  }
  for (const secret of [
    ...phrases,
    ...passwords,
    originalPassword,
    ...toolRecovery.secrets,
    canary,
    projectTitle,
  ])
    assert.equal(wire.includes(secret), false);
  assert.notEqual(
    original.vault.signingKey,
    unlockedAccount()!.vault.signingKey,
  );
  console.log(
    "Native recovery verified: seed-only proofs, paged encrypted catalogues, atomic competing plans, immediate phrase replacement, old-session revocation, historical decryption, lost-reply recovery and a second recovery with preserved old data.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  for (const client of [owner, first, second, toolMember])
    client.setToken(null);
}
