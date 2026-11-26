import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient,
  RpcClientError,
  type Client,
  type MutateInput,
  type MutateResult,
} from "@sortsys/v2-client";
import {
  areaKey,
  base64,
  bytes,
  decryptObject,
  domainBoxSigner,
  encryptObject,
  openBox,
  verifyDomain,
  type EncryptedObject,
  resourceCommandBinding,
  verify,
  objectFrame,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import {
  createMemberInvitation,
  signInMemberInvitation,
  approveMemberInvitation,
} from "../app/lib/crypto/invitations";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { synchronizeToolResponsibilityDefaults } from "../app/lib/crypto/toolResponsibilityDefaults";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { addressId } from "../app/lib/data/addressBook";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { TOOL_MODEL, toolCollection } from "../app/lib/data/toolData";
import { prepareToolReturnKeys, signToolReturn } from "../app/lib/data/toolReturnKey";
import {
  finishToolBookingRotations,
  toolResponsibilityPacket,
} from "../app/lib/data/toolResponsibility";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

export async function exerciseLateToolResponsibility(
  owner: Client,
  peer: Client,
) {
  const signal = new AbortController().signal;
  const ownerAccount = unlockedAccount()!;
  const unlockOwner = () =>
    acceptVaultWithKey(
      ownerAccount.dataKey,
      ownerAccount.vault,
      ownerAccount.username,
      false,
    );
  let stripOneState = true;
  const observed: Client = {
    ...owner,
    mutate: (async (path, input, options) => {
      if (path === "zerotrust.objects.batch" && stripOneState) {
        const changed = structuredClone(
          input as MutateInput<"zerotrust.objects.batch">,
        );
        for (const packet of changed.objects) {
          if (packet.resourceAccess?.active) {
            // Represent a real earlier booking that predates live-state proofs.
            delete packet.resourceAccess;
            stripOneState = false;
            return owner.mutate("zerotrust.objects.batch", changed, options);
          }
        }
      }
      return owner.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, {
    productDriver: duckDriver,
  });
  const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS!);
  const member = createClient(endpoints[0], "native-late-tool-member");
  let restricted: ReturnType<typeof createBusinessClient> | undefined;
  try {
    const person = await required(
      business.mutate("users.create", {
        username: "late.tool.member",
        firstName: "Später",
        lastName: "Werkzeugzugang",
        email: null,
        phone: null,
        costPerHour: 0,
        vacationDaysPerYear: 28,
        contractType: "internal",
        supervisorUserId: null,
      }),
    );
    const tools: MutateResult<"tools.create">[] = [];
    for (const label of [
      "Aktive Ausgabe",
      "Frühere Ausgabe",
      "Projektbuchung vor der Registrierung",
    ]) {
      const customId = await required(
        business.query("tools.suggestNextCustomId", undefined),
      );
      tools.push(
        await required(
          business.mutate("tools.create", {
            customId,
            brand: "Privater Werkzeugbestand 571943",
            category: "Montage",
            label,
            purchasePrice: 1479.25,
            usageCostPerDay: 23.875,
          }),
        ),
      );
    }
    const project = await required(business.mutate("projects.create", {
      title: "Projekt für die nachträgliche Werkzeugfreigabe",
    }));
    const bookings = [];
    for (const tool of tools) {
      const operationId = publicId(newProductRowId());
      const result = await required(
        business.mutate("tools.trackMany", {
          operationId,
          tools: [{ id: tool.id, expectedTrackingId: null }],
          data: {
            responsibleUserId: person.id,
            comment: "Vertrauliche Ausgabe vor der Registrierung",
            ...(tool === tools[2] ? { projectId: project.id } : {}),
          },
        }),
      );
      bookings.push(result.trackings[0]!);
    }
    assert.equal(stripOneState, false);
    const projectBookingId = bookings[2]!.trackingId;
    const projectBookingArea = toolCollection("tool-tracking", projectBookingId, "master-data");
    const initialProjectBooking = await required(peer.query(
      "zerotrust.creations.origin",
      { domain: projectBookingArea.domain },
      { strategy: "network-only" },
    ));
    assert.ok(initialProjectBooking?.access?.active);
    assert.equal(initialProjectBooking.access.commandBinding, undefined);
    await required(business.mutate("tools.untrack", { id: tools[1]!.id }));
    const area = toolCollection(
      "tool-tracking",
      bookings[0]!.trackingId,
      "master-data",
    );
    const before = await required(
      peer.query(
        "zerotrust.creations.origin",
        { domain: area.domain },
        { strategy: "network-only" },
      ),
    );
    assert.ok(before);
    assert.equal(before.assignee, undefined);
    assert.equal(before.access, undefined);
    const original = await required(
      peer.query(
        "zerotrust.objects.get",
        { id: area.prefix },
        { strategy: "network-only" },
      ),
    );
    const invitation = await createMemberInvitation(
      observed,
      { id: person.id, username: "late.tool.member" },
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
      member,
      invitation.link,
      "Late-tool-member-password-2026!",
      signal,
    );
    const account = unlockedAccount()!;
    await unlockOwner();
    await approveMemberInvitation(
      observed,
      invitation.link.invitation.id,
      signal,
      duckDriver,
    );
    const checkpoint = await required(
      peer.query(
        "zerotrust.creations.origin",
        { domain: area.domain },
        { strategy: "network-only" },
      ),
    );
    assert.ok(checkpoint?.access?.active);
    assert.ok(checkpoint.access.commandBinding);
    assert.equal(checkpoint.assignee, undefined);
    assert.equal(
      BigInt(checkpoint.access.revision),
      BigInt(original.revision) + 1n,
    );
    const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
    assert.ok(root);
    await writeFile(
      join(root, "tool-authorization-witness.json"),
      JSON.stringify({
        tenant: checkpoint.tenant,
        domain: area.domain,
        origin: checkpoint,
      }),
      { mode: 0o600 },
    );
    const policy = await required(
      peer.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    );
    await synchronizeToolResponsibilityDefaults(observed, signal, duckDriver);
    assert.equal(
      (
        await required(
          peer.query("zerotrust.policy.get", undefined, {
            strategy: "network-only",
          }),
        )
      ).signature,
      policy.signature,
    );
    assert.equal(
      (
        await required(
          peer.query(
            "zerotrust.objects.get",
            { id: area.prefix },
            { strategy: "network-only" },
          ),
        )
      ).signature,
      checkpoint.access.packetSignature,
    );

    await acceptVaultWithKey(
      account.dataKey,
      account.vault,
      account.username,
      false,
    );
    restricted = createBusinessClient(member, { productDriver: duckDriver });
    const assigned = await required(
      restricted.query("tools.trackings.list", {}),
    );
    assert.deepEqual(
      assigned.map((booking) => booking.id).sort(),
      [bookings[0]!.trackingId, projectBookingId].sort(),
    );
    for (const booking of assigned) {
      assert.equal(booking.toolUsageCostPerDay, null);
      assert.equal(booking.canReturnOwn, true);
      assert.equal(booking.toolSummary?.brand, "Privater Werkzeugbestand 571943");
    }
    assert.ok((await restricted.query("tools.get", { id: tools[2]!.id }))[1]);
    await required(restricted.mutate("tools.trackings.return", { trackingId: projectBookingId }));
    await unlockOwner();
    const returnedProjectTool = await required(peer.query("tools.get", { id: tools[2]!.id }));
    assert.equal(returnedProjectTool.available, true);
    const costs = await required(peer.query("projects.costs.get", { projectId: project.id }));
    const returnedUsage = costs.toolTrackings.find(({ id }) => id === projectBookingId);
    assert.ok(returnedUsage?.endedAt instanceof Date);
    assert.equal(returnedUsage.endedByUserId, person.id);
    assert.equal(returnedUsage.toolUsageCostPerDay, 23.875);
    await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
    for (const forbidden of [
      toolCollection("tool", tools[0]!.id, "master-data"),
      toolCollection("tool-tracking", bookings[0]!.trackingId, "procurement"),
      toolCollection("tool-tracking", bookings[1]!.trackingId, "master-data"),
    ]) {
      const [, error] = await member.query(
        "zerotrust.keys.get",
        { domain: forbidden.domain, generation: "1" },
        { strategy: "network-only" },
      );
      assert.equal(error?.code, "FORBIDDEN");
    }
    const access = await verifiedAccessContext(member, signal, {
      domain: area.domain,
    });
    const domain = access.domains.find((domain) => domain.id === area.domain)!;
    const definition = await verifyDomain(
      await required(
        member.query(
          "zerotrust.domains.get",
          {
            domain: area.domain,
            generation: domain.generation,
          },
          { strategy: "network-only" },
        ),
      ),
      {
        tenant: account.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: domain.generation,
      },
      access.history.authority,
    );
    const box = await required(
      member.query(
        "zerotrust.keys.get",
        { domain: area.domain, generation: domain.generation },
        { strategy: "network-only" },
      ),
    );
    const raw = await openBox(
      box,
      {
        tenant: account.tenant,
        purpose: "area-key",
        object: area.domain,
        generation: domain.generation,
        recipient: account.vault.subject,
        author: box.author,
      },
      account.identity.encryptionKey.privateKey,
      await domainBoxSigner(definition, box, access.history.authority),
    );
    const retainedKey = await areaKey(raw);
    raw.fill(0);
    const collection = await protectedCollection(member, area, signal);
    try {
      const previous = await collection.get(area.prefix);
      const forged = await encryptObject(
        {
          tenant: account.tenant,
          scope: area.scope,
          facet: area.facet,
          object: area.prefix,
          generation: domain.generation,
          policyVersion: access.rootPolicy.version,
          revision: (BigInt(previous.envelope.revision) + 1n).toString(),
          author: account.vault.subject,
        },
        bytes(JSON.stringify(previous.value)),
        retainedKey,
        account.identity.signingKey.privateKey,
      );
      const resourceAccess = await toolResponsibilityPacket(
        access.origins.find((origin) => origin.id === area.domain),
        forged,
        previous.value,
        access.history.identityCertificate(account.vault.subject),
        account.identity.signingKey.privateKey,
      );
      const [, denied] = await member.mutate("zerotrust.objects.batch", {
        objects: [
          {
            domain: area.domain,
            messageId: `msg_${crypto.randomUUID()}`,
            envelope: forged,
            resourceAccess,
          },
        ],
        heads: [{ domain: area.domain, sequence: await collection.inspect() }],
      });
      assert.ok(denied instanceof RpcClientError);
      assert.equal(denied.code, "FORBIDDEN");
    } finally {
      collection.close();
    }
    async function returnTool(): Promise<EncryptedObject> {
      await unlockOwner();
      await required(business.mutate("tools.untrack", { id: tools[0]!.id }));
      const afterReturn = await protectedCollection(observed, area, signal);
      try {
        const [old] = await afterReturn.read();
        assert.ok(old);
        const value = structuredClone(old.value) as {
          rows: { values: Record<string, unknown> }[];
        };
        value.rows[0]!.values.comment =
          "Private Ergänzung nach der Rückgabe 681527";
        const packet = await afterReturn.packet(
          area.prefix,
          value,
          old.envelope,
        );
        await afterReturn.write([packet]);
        return (await afterReturn.get(area.prefix)).envelope;
      } finally {
        afterReturn.close();
      }
    }
    let after: EncryptedObject;
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      const { exerciseToolResponsibilityBrowser } =
        await import("./test-tool-responsibility-browser");
      after = await exerciseToolResponsibilityBrowser(
        {
          tenant: account.tenant,
          member: {
            username: "late.tool.member",
            password: "Late-tool-member-password-2026!",
          },
          activeLabel: "Aktive Ausgabe",
          closedLabel: "Frühere Ausgabe",
          toolBrand: "Privater Werkzeugbestand 571943",
          toolId: tools[0]!.id,
          bookingDomain: area.domain,
        },
        returnTool,
      );
    } else {
      after = await returnTool();
    }
    await acceptVaultWithKey(
      account.dataKey,
      account.vault,
      account.username,
      false,
    );
    await restricted.invalidate("tools.trackings.list");
    assert.deepEqual(
      await required(restricted.query("tools.trackings.list", {})),
      [],
    );
    const [, revoked] = await member.query(
      "zerotrust.keys.get",
      { domain: area.domain, generation: domain.generation },
      { strategy: "network-only" },
    );
    assert.equal(revoked?.code, "FORBIDDEN");
    assert.equal(after!.author, ownerAccount.vault.subject);
    await verify(
      ownerAccount.identity.signingKey.publicKey,
      after!.signature,
      objectFrame(after!),
    );
    await assert.rejects(
      decryptObject(
        after!,
        {
          tenant: after!.tenant,
          scope: after!.scope,
          facet: after!.facet,
          object: after!.object,
          revision: after!.revision,
          generation: after!.generation,
          policyVersion: after!.policyVersion,
          author: after!.author,
        },
        retainedKey,
        ownerAccount.identity.signingKey.publicKey,
      ),
    );
    console.log(
      "Native late tool responsibility: earlier active booking checkpointed at invitation approval, closed booking and costs hidden, exact retry unchanged, authentic reader write denied, return revokes access and retained key cannot read later changes",
    );
    await unlockOwner();
    await exerciseOwnToolReturn(
      business, peer, member, tools[1]!.id, person.id, unlockOwner,
      () => acceptVaultWithKey(account.dataKey, account.vault, account.username, false),
      signal,
    );
    await exerciseDelegatedToolReturn(
      business,
      peer,
      member,
      tools[0]!.id,
      person.id,
      unlockOwner,
      signal,
    );
  } finally {
    restricted?.dispose();
    business.dispose();
    await unlockOwner();
  }
}

async function exerciseOwnToolReturn(
  owner: Client,
  peer: Client,
  member: Client,
  toolId: string,
  memberId: string,
  unlockOwner: () => Promise<unknown>,
  unlockMember: () => Promise<unknown>,
  signal: AbortSignal,
) {
  const project = await required(owner.mutate("projects.create", {
    title: "Projekt für eigene Werkzeugrückgaben",
  }));
  async function assign() {
    return required(owner.mutate("tools.track", {
      id: toolId,
      data: { responsibleUserId: memberId, projectId: project.id },
    }));
  }
  type Publish = MutateInput<"zerotrust.toolReturns.publish">;
  let request: Publish | undefined;
  let mode: "false-reply" | "lost-reply" = "false-reply";
  const observed: Client = {
    ...member,
    mutate: (async (path, input, options) => {
      if (path !== "zerotrust.toolReturns.publish")
        return member.mutate(path, input, options);
      const publication = input as Publish;
      request = publication;
      if (mode === "false-reply") return [publication.command, null];

      const [wrongActor, denied] = await owner.mutate("zerotrust.toolReturns.publish", publication);
      assert.equal(wrongActor, null);
      assert.equal(denied instanceof RpcClientError && denied.code, "FORBIDDEN");
      await required(member.mutate("zerotrust.toolReturns.publish", publication, options));
      return [null, new Error("Lost return acknowledgement")];
    }) as Client["mutate"],
  };
  const assigned = await assign();
  const trackingId = assigned.trackingId;
  const area = toolCollection("tool-tracking", trackingId, "master-data");
  const before = await required(peer.query("zerotrust.objects.get", { id: area.prefix }, {
    strategy: "network-only",
  }));
  await unlockMember();
  const restricted = createBusinessClient(observed, { productDriver: duckDriver });
  try {
    const active = await required(restricted.query("tools.trackings.list", { toolId }));
    assert.equal(active[0]?.canReturnOwn, true);
    assert.equal(active[0]?.toolUsageCostPerDay, null);
    assert.ok((await restricted.query("tools.get", { id: toolId }))[1]);
    assert.ok((await restricted.mutate("tools.untrack", { id: toolId }))[1]);
    assert.ok((await restricted.mutate("tools.trackings.return", { trackingId }))[1]);
    assert.ok(request);
    assert.deepEqual(await required(member.query("zerotrust.toolReturns.lookup", {
      verificationKeys: [request.command.verificationKey],
    }, { strategy: "network-only" })), [null]);

    mode = "lost-reply";
    await required(restricted.mutate("tools.trackings.return", { trackingId }));
    assert.ok(request);
    assert.deepEqual(
      await required(member.mutate("zerotrust.toolReturns.publish", request)),
      request.command,
    );
    assert.deepEqual(await required(restricted.query("tools.trackings.list", { toolId })), []);
    assert.equal((await member.query("zerotrust.keys.get", {
      domain: area.domain, generation: before.generation,
    }, { strategy: "network-only" }))[1]?.code, "FORBIDDEN");
  } finally {
    restricted.dispose();
    await unlockOwner();
  }
  assert.ok(request);
  const verified = request.command;
  const returnedAt = new Date(Number(verified.issuedAt));
  const unknownKey = base64(new Uint8Array(32).fill(5));
  assert.match(await resourceCommandBinding(unknownKey), /^[-_]/);
  const selection = {
    verificationKeys: [
      await resourceCommandBinding(verified.verificationKey),
      verified.verificationKey,
      unknownKey,
    ],
  };
  assert.deepEqual(await required(peer.query("zerotrust.toolReturns.lookup", selection)), [
    null, verified, null,
  ]);
  const after = await required(peer.query("zerotrust.objects.get", { id: area.prefix }, {
    strategy: "network-only",
  }));
  assert.equal(after.signature, before.signature);
  assert.equal((await required(peer.query("tools.get", { id: toolId }))).available, true);
  const history = await required(peer.query("tools.trackings.list", { toolId, finished: true }));
  const finished = history.find((row) => row.id === trackingId);
  assert.equal(finished?.endedByUserId, memberId);
  assert.deepEqual(finished?.endedAt, returnedAt);
  const costs = await required(peer.query("projects.costs.get", { projectId: project.id }));
  const usage = costs.toolTrackings.find((entry) => entry.id === trackingId);
  assert.equal(usage?.endedByUserId, memberId);
  assert.deepEqual(usage?.endedAt, returnedAt);

  const competing = await assign();
  const transferId = (await required(owner.mutate("tools.trackings.transfers.request", {
    toolTrackingId: competing.trackingId, transferToUserId: memberId,
  }))).id;
  const competingArea = toolCollection("tool-tracking", competing.trackingId, "master-data");
  await unlockMember();
  const source = await protectedCollection(member, competingArea, signal);
  let command: Publish["command"];
  try {
    const [opened] = await source.read();
    assert.ok(opened);
    const booking = TOOL_MODEL.decode(opened.value, competingArea.prefix, competingArea);
    assert.ok(booking.returnKey);
    command = await signToolReturn(
      member, booking.returnKey, competing.trackingId, opened.envelope.revision,
      new Date(booking.rows[0]!.values.started_at as string), signal,
    );
  } finally {
    source.close();
    await unlockOwner();
  }
  let competed = false;
  const intercepted: Client = {
    ...owner,
    mutate: (async (path, input, options) => {
      if (path === "zerotrust.objects.batch" && !competed) {
        const packet = input as MutateInput<"zerotrust.objects.batch">;
        if (packet.objects.some(
          ({ domain, resourceAccess }) => domain === competingArea.domain && resourceAccess?.active === false,
        )) {
          await required(member.mutate("zerotrust.toolReturns.publish", {
            trackingId: competing.trackingId, command,
          }));
          competed = true;
        }
      }
      return owner.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const transfer = createBusinessClient(intercepted, { productDriver: duckDriver });
  try {
    const [, error] = await transfer.mutate("tools.trackings.transfers.accept", { id: transferId });
    assert.ok(error);
    assert.equal(competed, true, error.message);
  } finally {
    transfer.dispose();
  }
  const transfers = await required(peer.query("tools.trackings.transfers.list", {
    toolId, status: "denied",
  }));
  assert.ok(transfers.some((transfer) => transfer.id === transferId));
  const next = await assign();
  await required(member.mutate("zerotrust.toolReturns.publish", {
    trackingId: competing.trackingId, command,
  }));
  const current = await required(peer.query("tools.get", { id: toolId }));
  assert.equal(current.activeTrackingId, next.trackingId);
  console.log("Native own tool return: separate API replicas check denied actors, false and lost replies, lost read access, costs, competing transfers and later booking");

  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    const { exerciseToolResponsibilityBrowser } =
      await import("./test-tool-responsibility-browser");

    await exerciseToolResponsibilityBrowser({
      tenant: unlockedAccount()!.tenant,
      member: {
        username: "late.tool.member",
        password: "Late-tool-member-password-2026!",
      },
      activeLabel: "Frühere Ausgabe",
      toolBrand: "Privater Werkzeugbestand 571943",
      toolId,
      bookingDomain: toolCollection("tool-tracking", next.trackingId, "master-data").domain,
      artifactName: "own-tool-return",
      selfReturn: true,
    }, async () => {});

    const returned = await required(peer.query("tools.get", { id: toolId }, {
      strategy: "network-only",
    }));
    assert.equal(returned.activeTrackingId, null);
  }
}

async function exerciseDelegatedToolReturn(
  owner: ReturnType<typeof createBusinessClient>,
  peer: Client,
  formerReader: Client,
  toolId: string,
  readerId: string,
  unlockOwner: () => Promise<unknown>,
  signal: AbortSignal,
) {
  const manager = await required(owner.mutate("users.create", {
    username: "scoped.tool.manager",
    firstName: "Werkzeugverwaltung",
    lastName: "Bereichsfreigabe",
  }));
  const invitation = await createMemberInvitation(
    owner,
    { id: manager.id, username: "scoped.tool.manager" },
    {
      catalogue: "none", customers: "none", contacts: "none", vendors: "none",
      prices: "none", assistant: false,
    },
    signal,
  );
  const endpoint = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS!)[1];
  const managerClient = createClient(endpoint, "native-scoped-tool-manager");
  const managerPassword = "Scoped-tool-manager-passphrase-2026!";
  await signInMemberInvitation(
    managerClient,
    invitation.link,
    managerPassword,
    signal,
  );
  const managerAccount = unlockedAccount()!;
  const unlockManager = () => acceptVaultWithKey(
    managerAccount.dataKey, managerAccount.vault, managerAccount.username, false,
  );
  await unlockOwner();
  await approveMemberInvitation(owner, invitation.link.invitation.id, signal, duckDriver);
  const { trackingId } = await required(owner.mutate("tools.track", {
    id: toolId,
    data: { responsibleUserId: readerId },
  }));
  const tracking = toolCollection("tool-tracking", trackingId, "master-data");
  const requests = toolCollection("tool-tracking", trackingId, "scope");
  const tool = toolCollection("tool", toolId, "master-data");
  await changeAreaActionAccesses(owner, managerAccount.vault.subject, [
    { area: tracking, patch: { read: true, update: true, grant: true } },
    { area: requests, patch: { read: true, update: true } },
    { area: tool, patch: { read: true, update: true } },
  ], signal);

  async function domains() {
    const access = await verifiedAccessContext(peer, signal, {
      domains: [tracking.domain, requests.domain],
    });
    const current = access.domains.find((area) => area.id === tracking.domain);
    const transfers = access.domains.find((area) => area.id === requests.domain);
    assert.ok(current && transfers);
    return { current, transfers };
  }
  const before = await domains();
  const operational = createBusinessClient(managerClient, { productDriver: duckDriver });
  let stage = "return with a delegated signing certificate";
  try {
    await unlockManager();
    const session = await required(managerClient.query("auth.sessionInfo", undefined));
    assert.ok(!session.roles.includes(":admin"));
    const close = { id: toolId, expectedTrackingId: trackingId };
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      const { exerciseToolResponsibilityBrowser } =
        await import("./test-tool-responsibility-browser");
      await exerciseToolResponsibilityBrowser({
        tenant: managerAccount.tenant,
        member: {
          username: "late.tool.member",
          password: "Late-tool-member-password-2026!",
        },
        manager: { username: "scoped.tool.manager", password: managerPassword },
        activeLabel: "Aktive Ausgabe",
        toolBrand: "Privater Werkzeugbestand 571943",
        toolId,
        bookingDomain: tracking.domain,
        artifactName: "scoped-tool-return",
      }, async () => {});
    } else {
      await required(operational.mutate("tools.untrack", close));
    }
    await unlockOwner();
    const after = await domains();
    assert.equal(BigInt(after.current.generation), BigInt(before.current.generation) + 1n);
    assert.equal(after.current.rotationRequired, false);
    assert.equal(after.transfers.generation, before.transfers.generation);
    assert.equal(after.transfers.rotationRequired, true);
    const definition = await required(peer.query("zerotrust.domains.get", {
      domain: tracking.domain,
      generation: after.current.generation,
    }, { strategy: "network-only" }));
    assert.equal(definition.keyAuthority?.holder.user, managerAccount.vault.subject);
    const [, revoked] = await formerReader.query("zerotrust.keys.get", {
      domain: tracking.domain, generation: after.current.generation,
    }, { strategy: "network-only" });
    assert.equal(revoked?.code, "FORBIDDEN");

    stage = "reissue the same tool to the previous assignee";
    const next = await required(owner.mutate("tools.track", {
      id: toolId,
      data: { responsibleUserId: readerId },
    }));
    stage = "repeat the old return and reject the ungranted return";
    await unlockManager();
    await required(operational.mutate("tools.untrack", close));
    const [, denied] = await operational.mutate("tools.untrack", {
      id: toolId, expectedTrackingId: next.trackingId,
    });
    assert.ok(denied);
    await unlockOwner();
    const active = await required(owner.query("tools.get", { id: toolId }, {
      strategy: "network-only",
    }));
    assert.equal(active.activeTrackingId, next.trackingId);
    stage = "resume the pending rotation through the owner";
    await finishToolBookingRotations(owner, new Set([tracking.scope]), signal);
    const repaired = await domains();
    assert.equal(repaired.current.generation, after.current.generation);
    assert.equal(BigInt(repaired.transfers.generation), BigInt(before.transfers.generation) + 1n);
    assert.equal(repaired.transfers.rotationRequired, false);
    console.log("Scoped tool return: manager rotated only the certified facet; exact retry left the new booking untouched; owner resumed the other facet");

    stage = "deny a first return key to a delegated booking editor";
    await required(owner.mutate("tools.untrack", { id: toolId }));
    const pending = await required(owner.mutate("users.create", {
      username: "pending.tool.responsible",
      firstName: "Noch nicht registriert",
    }));
    const unkeyed = await required(owner.mutate("tools.track", {
      id: toolId,
      data: { responsibleUserId: pending.id },
    }));
    const source = toolCollection("tool-tracking", unkeyed.trackingId, "master-data");
    await changeAreaActionAccesses(owner, managerAccount.vault.subject, [
      { area: source, patch: { read: true, update: true } },
    ], signal);
    await unlockManager();
    const editable = await protectedCollection(managerClient, source, signal);
    try {
      const [stored] = await editable.read();
      assert.ok(stored);
      const value = TOOL_MODEL.decode(stored.value, source.prefix, source);
      assert.equal(value.returnKey, undefined);
      value.rows[0]!.values.comment = "Zulässige Ergänzung ohne Rückgabeschlüssel";
      await editable.write([await editable.packet(source.prefix, value, stored.envelope)]);
      const current = await editable.get(source.prefix);
      value.rows[0]!.values.responsible_user_id = addressId(manager.id);
      const prepare = await prepareToolReturnKeys(managerClient, addressId(manager.id), signal);
      assert.ok(prepare);
      value.returnKey = await prepare(unkeyed.trackingId);
      const packet = await editable.packet(source.prefix, value, current.envelope);
      assert.ok(packet.resourceAccess?.commandBinding);
      const [accepted, error] = await managerClient.mutate("zerotrust.objects.batch", {
        objects: [packet],
        heads: [{ domain: source.domain, sequence: await editable.inspect() }],
      });
      assert.equal(accepted, null);
      assert.ok(error instanceof RpcClientError);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal((await editable.get(source.prefix)).envelope.signature, current.envelope.signature);
    } finally {
      editable.close();
    }
    console.log("A delegated editor can update an unkeyed checkout but cannot install its first return key");
  } catch (cause) {
    throw new Error(`Scoped tool return failed while attempting to ${stage}`, { cause });
  } finally {
    operational.dispose();
    managerClient.setToken(null);
    await unlockOwner();
  }
}
