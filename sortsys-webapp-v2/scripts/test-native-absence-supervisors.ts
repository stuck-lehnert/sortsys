import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  areaKey,
  decryptObject,
  domainBoxSigner,
  openBox,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import { absenceCollection } from "../app/lib/data/absenceData";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { personnelCollection } from "../app/lib/data/personnelData";
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
const tenant = "absence-supervisors-tenant";
assert.equal(process.env.SORTSYS_NATIVE_AUTH_TENANT, tenant);
const reportPath = process.argv[4];
assert.ok(reportPath);

const signal = new AbortController().signal;
const ownerInput = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};
const memberPassword = "Disposable-absence-account-2026!";
const privateNote = "Vertrauliche Urlaubsnotiz 872431";
const traffic: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") traffic.push(args[1].body);
    const input = args[0] instanceof Request ? args[0].url : String(args[0]);
    const parameters = new URL(input).searchParams;
    for (const value of parameters.values()) traffic.push(value);
    return Reflect.apply(target, receiver, args);
  },
});
const owner = createClient(endpoints[0], "absence-owner");
const peer = createClient(endpoints[1], "absence-peer-owner");
const clients = [owner, peer];

type Account = { client: Client; vault: UnlockedAccount };
type Person = Account & { id: string };
type Business = ReturnType<typeof createBusinessClient>;

function unlock(account: Account) {
  const { vault } = account;
  return acceptVaultWithKey(vault.dataKey, vault.vault, vault.username, false);
}

async function useBusiness<T>(
  account: Account,
  work: (business: Business) => Promise<T>,
): Promise<T> {
  await unlock(account);
  const business = createBusinessClient(account.client, {
    productDriver: duckDriver,
  });
  try {
    return await work(business);
  } finally {
    business.dispose();
  }
}

async function addMember(
  administrator: Account,
  endpoint: string,
  username: string,
  supervisorUserId: string | null = null,
): Promise<Person> {
  const profile = await useBusiness(administrator, (business) =>
    required(business.mutate("users.create", {
      username,
      firstName: username,
      contractType: "internal",
      supervisorUserId,
      vacationDaysPerYear: 28,
      costPerHour: 81.25,
    })),
  );
  const { link } = await createMemberInvitation(
    administrator.client,
    { id: profile.id, username },
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
  const client = createClient(endpoint, `absence-${username}`);
  clients.push(client);
  await signInMemberInvitation(client, link, memberPassword, signal);
  await joinMemberInvitation(client, link, signal);
  await unlock(administrator);
  await approveMemberInvitation(
    administrator.client,
    link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(client, { tenant, username, password: memberPassword });
  const session = await required(client.query("auth.sessionInfo", undefined));
  assert.equal(session.roles.includes(":admin"), false);
  const vault = unlockedAccount();
  assert.ok(vault);
  return { client, vault, id: profile.id };
}

function createRequest(person: Person, from: string, to: string) {
  return useBusiness(person, (business) =>
    required(business.mutate("users.vacations.create", {
      userId: person.id,
      operationId: publicId(newProductRowId()),
      from,
      to,
      type: "vacation",
      note: privateNote,
    })),
  );
}

async function readRequest(account: Account, userId: string, id: string) {
  const requests = await useBusiness(account, (business) =>
    required(business.query("users.vacations.list", { userId })),
  );
  const request = requests.find((row) => row.id === id);
  assert.ok(request);
  return request;
}

async function assertNoRead(account: Account, userId: string) {
  const [, error] = await useBusiness(account, (business) =>
    business.query("users.vacations.list", { userId }),
  );
  assert.ok(error, "The targeted absence lookup requires both read grants");
  for (const decision of [false, true]) {
    await assert.rejects(async () => {
      const collection = await protectedCollection(
        account.client, absenceCollection(userId, decision), signal,
      );
      collection.close();
    });
  }
}

async function readAreaStates(account: Account, domains: string[]) {
  await unlock(account);
  const { domains: states } = await verifiedAccessContext(
    account.client, signal, { domains },
  );
  return new Map(states.map((domain) => [domain.id, domain]));
}

async function retainDecisionKey(
  person: Person,
  userId: string,
  generation: string,
) {
  await unlock(person);
  const area = absenceCollection(userId, true);
  const { history } = await verifiedAccessContext(person.client, signal, {
    domains: [area.domain],
  });
  const openings = await required(person.client.query("zerotrust.keys.history", {
    domain: area.domain,
    generations: [generation],
  }));
  assert.equal(openings.length, 1);
  const opening = openings[0];
  assert.ok(opening?.envelope);
  const box = opening.envelope;
  const definition = await verifyDomain(
    opening.definition,
    { tenant, id: area.domain, scope: area.scope, facet: area.facet, generation },
    history.authority,
  );
  const plaintext = await openBox(
    box,
    {
      tenant,
      object: area.domain,
      purpose: "area-key",
      generation,
      recipient: person.vault.vault.subject,
      author: box.author,
    },
    person.vault.identity.encryptionKey.privateKey,
    await domainBoxSigner(definition, box, history.authority),
  );
  try {
    return await areaKey(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

try {
  await signIn(owner, ownerInput);
  await initializeTenant(owner, signal, duckDriver);
  const ownerVault = unlockedAccount();
  assert.ok(ownerVault);
  const administrator = { client: owner, vault: ownerVault };
  await signIn(peer, ownerInput);
  const peerVault = unlockedAccount();
  assert.ok(peerVault);
  const administratorOnPeer = { client: peer, vault: peerVault };

  const oldLead = await addMember(administrator, endpoints[1], "alte.leitung");
  const directLead = await addMember(
    administrator, endpoints[1], "kolonnenleitung", oldLead.id,
  );
  const newLead = await addMember(administrator, endpoints[0], "neue.leitung");
  const worker = await addMember(
    administrator, endpoints[0], "mitarbeiter", directLead.id,
  );
  console.log("Both API processes have active sessions for the approval chain.");

  const first = await createRequest(worker, "2026-12-07", "2026-12-11");
  assert.equal(first.status, "requested");
  assert.equal((await readRequest(worker, worker.id, first.id)).canApprove, false);
  assert.equal((await readRequest(directLead, worker.id, first.id)).canApprove, true);
  await assertNoRead(newLead, worker.id);
  const firstForLead = await readRequest(oldLead, worker.id, first.id);
  assert.equal(firstForLead.note, privateNote);
  assert.equal(firstForLead.canApprove, true);
  await assert.rejects(() => protectedCollection(
    oldLead.client, personnelCollection(worker.id, "calculation"), signal,
  ));
  await useBusiness(oldLead, (business) =>
    required(business.mutate("users.vacations.approve", {
      id: first.id,
      expectedRevision: firstForLead.revision,
    })),
  );
  assert.equal(
    (await readRequest(worker, worker.id, first.id)).decidedByUserId,
    oldLead.id,
  );

  await unlock(administrator);
  await changeAreaActionAccesses(
    owner,
    `user:${newLead.id}`,
    [{ area: absenceCollection(directLead.id, true), patch: { approve: false } }],
    signal,
  );
  await changeAreaActionAccesses(
    owner,
    `user:${oldLead.id}`,
    [{ area: personnelCollection(worker.id, "scope"), patch: { read: true } }],
    signal,
  );
  const pending = await createRequest(worker, "2026-12-14", "2026-12-18");
  const directLeadRequest = await createRequest(
    directLead, "2026-12-14", "2026-12-18",
  );
  assert.equal(pending.status, "requested");
  assert.equal(directLeadRequest.status, "requested");
  const oldRevision = (await readRequest(oldLead, worker.id, pending.id)).revision;
  const affected = [directLead.id, worker.id].flatMap((id) =>
    [absenceCollection(id).domain, absenceCollection(id, true).domain],
  );
  const previous = await readAreaStates(administrator, affected);
  const decisionArea = absenceCollection(worker.id, true);
  const previousDecision = previous.get(decisionArea.domain);
  assert.ok(previousDecision);
  const revokedKey = await retainDecisionKey(
    oldLead, worker.id, previousDecision.generation,
  );

  await useBusiness(administratorOnPeer, (business) =>
    required(business.mutate("users.update", {
      id: directLead.id,
      data: { supervisorUserId: newLead.id },
    })),
  );
  const current = await readAreaStates(administrator, affected);
  for (const id of affected) {
    const before = previous.get(id);
    const after = current.get(id);
    assert.ok(before && after);
    assert.equal(after.rotationRequired, false, id);
    assert.ok(BigInt(after.generation) > BigInt(before.generation), id);
  }

  await assertNoRead(oldLead, worker.id);
  await assertNoRead(oldLead, directLead.id);
  const [, forbidden] = await useBusiness(oldLead, (business) =>
    business.mutate("users.vacations.approve", {
      id: pending.id,
      expectedRevision: oldRevision,
    }),
  );
  assert.ok(forbidden);
  const profile = await useBusiness(oldLead, (business) =>
    required(business.query("users.get", { id: worker.id })),
  );
  assert.equal(profile.vacationDaysPerYear, 28, "Manual personnel read survives");
  assert.equal(profile.costPerHour, null);

  const vetoed = await readRequest(newLead, directLead.id, directLeadRequest.id);
  assert.equal(vetoed.status, "requested");
  assert.equal(vetoed.canApprove, false, "Explicit veto overrides the derived grant");
  const [, denied] = await useBusiness(newLead, (business) =>
    business.mutate("users.vacations.approve", {
      id: directLeadRequest.id,
      expectedRevision: vetoed.revision,
    }),
  );
  assert.ok(denied);
  assert.equal((await readRequest(directLead, worker.id, pending.id)).canApprove, true);
  const inherited = await readRequest(newLead, worker.id, pending.id);
  assert.equal(inherited.canApprove, true);
  await useBusiness(newLead, (business) =>
    required(business.mutate("users.vacations.approve", {
      id: pending.id,
      expectedRevision: inherited.revision,
    })),
  );
  const approved = await readRequest(worker, worker.id, pending.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedByUserId, newLead.id);

  const newDecision = await required(worker.client.query("zerotrust.objects.get", {
    id: decisionArea.prefix + pending.id,
  }));
  assert.equal(
    newDecision.generation,
    current.get(decisionArea.domain)?.generation,
  );
  const { scope, facet, object, revision, generation, policyVersion, author } =
    newDecision;
  await assert.rejects(() =>
    decryptObject(
      newDecision,
      { tenant, scope, facet, object, revision, generation, policyVersion, author },
      revokedKey,
      newLead.vault.identity.signingKey.publicKey,
    ),
  );
  assert.ok(traffic.some((request) => request.includes("sortsys-object-v1")));
  assert.equal(traffic.some((request) => request.includes(privateNote)), false);
  await writeFile(reportPath, JSON.stringify({
    success: true,
    rotatedDomains: affected.length,
    previousSupervisorRejected: true,
    formerKeyCannotOpenNewDecision: true,
    explicitVetoPreserved: true,
    manualPersonnelReadPreserved: true,
  }));
  console.log("Indirect approval, revocation and all four rotations verified.");
} finally {
  globalThis.fetch = originalFetch;
  for (const client of clients) client.setToken(null);
  lockCryptoSession();
}
