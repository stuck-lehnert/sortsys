import assert from "node:assert/strict";
import { RpcClientError, type Client } from "@sortsys/v2-client";
import {
  areaKey,
  decryptObject,
  domainBoxSigner,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { toolCollection, TOOL_MODEL } from "../app/lib/data/toolData";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import {
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  invitationMembers,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { openBox } from "@sortsys/zerotrust/sortsys";

type Login = { tenant: string; username: string; password: string };
type ToolRecovery = {
  member: Client;
  memberId: string;
  username: string;
  password: string;
  toolId: string;
  bookingId: string;
  closed: string[];
  key: CryptoKey;
  initial: NonNullable<Awaited<ReturnType<typeof initialDefinition>>>;
  secrets: string[];
  comments: Map<string, string>;
};
const signal = new AbortController().signal;
const marker = "Vertrauliche Werkzeugfreigabe 762941";
const noAdditionalAccess = {
  catalogue: "none",
  customers: "none",
  contacts: "none",
  vendors: "none",
  prices: "none",
  assistant: false,
} as const;

async function asBusiness<T>(
  client: Client,
  work: (business: ReturnType<typeof createBusinessClient>) => Promise<T>,
): Promise<T> {
  const business = createBusinessClient(client, { productDriver: duckDriver });
  try {
    return await work(business);
  } finally {
    business.dispose();
  }
}

async function enroll(
  owner: Client,
  member: Client,
  person: { id: string; username: string },
  login: Login,
  password: string,
) {
  const invitation = await createMemberInvitation(
    owner,
    person,
    noAdditionalAccess,
    signal,
  );
  await signInMemberInvitation(member, invitation.link, password, signal);
  await joinMemberInvitation(member, invitation.link, signal);
  await signIn(owner, login);
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(member, {
    tenant: login.tenant,
    username: person.username,
    password,
  });
}

async function initialDefinition(client: Client, bookingId: string) {
  return required(
    client.query(
      "zerotrust.domains.get",
      {
        domain: toolCollection("tool-tracking", bookingId, "master-data")
          .domain,
        generation: "1",
      },
      { strategy: "network-only" },
    ),
  );
}

async function retainBookingKey(client: Client, bookingId: string) {
  const account = unlockedAccount();
  assert.ok(account);
  const history = await trustedHistory(client);
  const session = await required(client.query("auth.sessionInfo", undefined));
  const area = toolCollection("tool-tracking", bookingId, "master-data");
  const definition = await verifyDomain(
    await initialDefinition(client, bookingId),
    {
      tenant: account.tenant,
      id: area.domain,
      scope: area.scope,
      facet: area.facet,
      generation: "1",
    },
    history.authority,
  );
  const box = await required(
    client.query(
      "zerotrust.keys.get",
      { domain: area.domain, generation: "1" },
      { strategy: "network-only" },
    ),
  );
  const raw = await openBox(
    box,
    {
      tenant: account.tenant,
      purpose: "area-key",
      object: area.domain,
      generation: "1",
      recipient: `user:${session.user.id}`,
      author: box.author,
    },
    account.identity.encryptionKey.privateKey,
    await domainBoxSigner(definition, box, history.authority),
  );
  try {
    return await areaKey(raw);
  } finally {
    raw.fill(0);
  }
}

async function book(owner: Client, toolId: string, memberId: string) {
  const operationId = publicId(newProductRowId());
  await asBusiness(owner, async (business) => {
    await required(
      business.mutate("tools.trackMany", {
        operationId,
        tools: [{ id: toolId, expectedTrackingId: null }],
        data: { responsibleUserId: memberId, comment: marker },
      }),
    );
  });
  return operationId;
}

/** Exercise production invitations and business adapters, with no plaintext
 * business handler or hand-crafted server-side recipient grant. */
export async function prepareNativeToolRecovery(
  owner: Client,
  member: Client,
  login: Login,
): Promise<ToolRecovery> {
  console.log(
    "Native tool recovery: preparing an assigned and a returned booking",
  );
  const username = "recovery.worker";
  const password = "Recovered-worker-password-762941!";
  const { person, toolId } = await asBusiness(owner, async (business) => {
    const person = await required(
      business.mutate("users.create", {
        username,
        firstName: "Werkzeug",
        lastName: "Wiederherstellung",
      }),
    );
    const customId = await required(
      business.query("tools.suggestNextCustomId", undefined),
    );
    const tool = await required(
      business.mutate("tools.create", {
        customId,
        brand: marker,
        category: "Montage",
        purchasePrice: 1547.5,
        usageCostPerDay: 31.25,
      }),
    );
    return { person, toolId: tool.id };
  });
  await enroll(owner, member, { id: person.id, username }, login, password);
  await signIn(owner, login);
  const returned = await book(owner, toolId, person.id);
  await asBusiness(owner, async (business) => {
    await required(business.mutate("tools.untrack", { id: toolId }));
  });
  const bookingId = await book(owner, toolId, person.id);
  const initial = await initialDefinition(owner, bookingId);
  assert.equal(initial.creation?.assignee?.user, `user:${person.id}`);
  await signIn(member, { tenant: login.tenant, username, password });
  await asBusiness(member, async (business) => {
    const bookings = await required(business.query("tools.trackings.list", {}));
    assert.equal(
      bookings.some((booking) => booking.id === returned),
      false,
    );
    assert.equal(
      bookings.find((booking) => booking.id === bookingId)?.toolUsageCostPerDay,
      null,
    );
    assert.equal(
      bookings.find((booking) => booking.id === bookingId)?.toolSummary?.brand,
      marker,
    );
  });
  const key = await retainBookingKey(member, bookingId);
  await signIn(owner, login);
  return {
    member,
    memberId: person.id,
    username,
    password,
    toolId,
    bookingId,
    closed: [returned],
    key,
    initial,
    secrets: [marker, password],
    comments: new Map(),
  };
}

async function assertDenied(client: Client, bookingId: string) {
  for (const facet of ["master-data", "scope", "procurement"] as const) {
    const [value, error] = await client.query(
      "zerotrust.keys.get",
      {
        domain: toolCollection("tool-tracking", bookingId, facet).domain,
        generation: "1",
      },
      { strategy: "network-only" },
    );
    assert.equal(value, null);
    assert.ok(error instanceof RpcClientError);
    assert.ok(error.code);
    assert.ok(["UNAUTHORIZED", "FORBIDDEN"].includes(error.code));
  }
}

/** Check the old conditional grants, retained keys and real return operation.
 * Re-enrolment also proves that old derived rights do not reappear afterwards. */
export async function verifyNativeToolRecovery(
  owner: Client,
  fixture: ToolRecovery,
  login: Login,
  reEnroll: boolean,
) {
  const generation = (await trustedHistory(owner)).current.generation;
  console.log(
    `Native tool recovery: checking recovered bookings in authority generation ${generation}`,
  );
  const former = (await invitationMembers(owner, signal)).find(
    (member) => member.id === fixture.memberId,
  );
  assert.ok(former);
  assert.equal(
    former.enrolled,
    true,
    "Recovery does not silently discard the existing password registration",
  );
  assert.equal(
    former.certified,
    false,
    "An old certificate is not a current tenant approval",
  );
  await assertDenied(fixture.member, fixture.bookingId);
  await asBusiness(owner, async (business) => {
    const tool = await required(
      business.query("tools.get", { id: fixture.toolId }),
    );
    assert.equal(tool.available, false);
    assert.equal(tool.brand, marker);
    assert.equal(tool.purchasePrice, 1547.5);
    assert.equal(tool.usageCostPerDay, 31.25);
    const bookings = await required(
      business.query("tools.trackings.list", { toolId: fixture.toolId }),
    );
    assert.equal(
      bookings.find((booking) => booking.id === fixture.bookingId)?.endedAt,
      null,
    );
    for (const closed of fixture.closed) {
      const booking = bookings.find((booking) => booking.id === closed);
      assert.ok(booking?.endedAt);
      if (fixture.comments.has(closed))
        assert.equal(booking.comment, fixture.comments.get(closed));
    }
    await required(business.mutate("tools.untrack", { id: fixture.toolId }));
    assert.equal(
      (await required(business.query("tools.get", { id: fixture.toolId })))
        .available,
      true,
    );
  });
  fixture.closed.push(fixture.bookingId);
  const area = toolCollection(
    "tool-tracking",
    fixture.bookingId,
    "master-data",
  );
  const collection = await protectedCollection(owner, area, signal);
  try {
    const [original] = await collection.read();
    assert.ok(original);
    const value = TOOL_MODEL.decode(
      structuredClone(original.value),
      area.prefix,
      area,
    );
    const comment = `Vertrauliche Werkzeugnotiz nach Recovery ${generation}`;
    fixture.secrets.push(comment);
    value.rows[0]!.values.comment = comment;
    const packet = await collection.packet(
      area.prefix,
      value,
      original.envelope,
    );
    await required(
      owner.mutate("zerotrust.objects.batch", {
        objects: [packet],
        heads: [{ domain: area.domain, sequence: await collection.inspect() }],
      }),
    );
    fixture.comments.set(fixture.bookingId, comment);
    const account = unlockedAccount();
    assert.ok(account);
    await assert.rejects(() =>
      decryptObject(
        packet.envelope,
        {
          tenant: account.tenant,
          scope: area.scope,
          facet: area.facet,
          object: area.prefix,
          revision: packet.envelope.revision,
          generation: packet.envelope.generation,
          policyVersion: packet.envelope.policyVersion,
          author: packet.envelope.author,
        },
        fixture.key,
        account.identity.signingKey.publicKey,
      ),
    );
  } finally {
    collection.close();
  }
  const [, replay] = await owner.mutate(
    "zerotrust.domains.put",
    fixture.initial,
  );
  if (replay) {
    assert.ok(replay instanceof RpcClientError);
    assert.ok(replay.code);
    assert.ok(["BAD_REQUEST", "CONFLICT", "FORBIDDEN"].includes(replay.code));
  }
  if (!reEnroll) return;
  await enroll(
    owner,
    fixture.member,
    { id: fixture.memberId, username: fixture.username },
    login,
    fixture.password,
  );
  assert.equal(
    (await trustedHistory(fixture.member)).current.generation,
    generation,
  );
  await assertDenied(fixture.member, fixture.bookingId);
  await asBusiness(fixture.member, async (business) => {
    assert.deepEqual(
      await required(business.query("tools.trackings.list", {})),
      [],
    );
  });
  await signIn(owner, login);
  assert.equal(
    (await invitationMembers(owner, signal)).find(
      (member) => member.id === fixture.memberId,
    )?.certified,
    true,
  );
  fixture.bookingId = await book(owner, fixture.toolId, fixture.memberId);
  fixture.initial = await initialDefinition(owner, fixture.bookingId);
  assert.equal(fixture.initial.creation?.capability.generation, generation);
  await signIn(fixture.member, {
    tenant: login.tenant,
    username: fixture.username,
    password: fixture.password,
  });
  await asBusiness(fixture.member, async (business) => {
    const bookings = await required(business.query("tools.trackings.list", {}));
    assert.deepEqual(
      bookings.map((booking) => booking.id),
      [fixture.bookingId],
    );
    assert.equal(bookings[0]!.toolUsageCostPerDay, null);
    assert.equal(bookings[0]!.toolSummary?.brand, marker);
  });
  fixture.key = await retainBookingKey(fixture.member, fixture.bookingId);
  await signIn(owner, login);
}
