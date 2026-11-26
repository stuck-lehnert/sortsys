import assert from "node:assert/strict";
import { RpcClientError, type Client, type QueryResult } from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  decryptObject,
  domainBoxSigner,
  encryptObject,
  openBox,
  replaceProjectRole,
  signPolicy,
  TOMBSTONE_FORMAT,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  trustedHistory,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import { administratorContext } from "../app/lib/crypto/administration";
import { readVerifiedPolicy } from "../app/lib/crypto/policy";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  changeAreaActionAccesses,
  changeProjectAccess,
  memberProjectAccess,
} from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { projectCollection } from "../app/lib/data/projectData";
import { fileCollection, fileObject, filePayload } from "../app/lib/data/projectFileData";
import { approvePreparedContent, inspectPreparedContent } from "../app/lib/backups/contentRestore";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import {
  PROJECT_ACCESS_KEYS,
  projectAccessArea,
  type ProjectAccessKey,
} from "../app/lib/data/projectScope";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";

const fresh = { strategy: "network-only" } as const;
const initialText = "Geschützter Projektbereich vor Schlüsselwechsel 819375";
const laterText = "Geschützter Projektbereich nach Schlüsselwechsel 980237";
const declinedText = "Abgewiesene Änderung mit gültiger Signatur 254194";

function contextOf(envelope: QueryResult<"zerotrust.objects.get">) {
  const { tenant, scope, facet, object, revision, generation, policyVersion, author } =
    envelope;
  return { tenant, scope, facet, object, revision, generation, policyVersion, author };
}

async function useAccount(account: UnlockedAccount) {
  await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
}

export async function testProjectModulePermissions(
  ownerClient: Client,
  memberClient: Client,
  owner: UnlockedAccount,
  member: UnlockedAccount,
  project: string,
  signal: AbortSignal,
  keys: readonly ProjectAccessKey[] = PROJECT_ACCESS_KEYS.filter((key) =>
    key.includes(":"),
  ),
) {
  const subject = member.vault.subject;
  const probes = keys.map((key) => {
    const prefix = `project-access-probe:${project}:${key}:`;
    const area = { ...projectAccessArea(project, key), prefix };
    return {
      key,
      area,
      initial: prefix + "initial",
      later: prefix + "later",
    };
  });
  await provisionOwnedCollections(
    ownerClient, owner.vault.subject, probes.map(({ area }) => area), signal,
  );

  async function write(probe: (typeof probes)[number], object: string, text: string) {
    const collection = await protectedCollection(ownerClient, probe.area, signal);
    try {
      await collection.read();
      const packet = await collection.packet(object, { text });
      await collection.write([packet]);
      return packet.envelope;
    } finally {
      collection.close();
    }
  }

  for (const probe of probes) await write(probe, probe.initial, initialText);
  for (const probe of probes) {
    const { key, area } = probe;
    await changeProjectAccess(ownerClient, subject, project, "read", signal, key);
    let accessSnapshots = 0;
    const observingOwner: Client = {
      ...ownerClient,
      query: ((path, input, options) => {
        if (path === "zerotrust.access.snapshot") accessSnapshots++;
        return ownerClient.query(path, input, options);
      }) as Client["query"],
    };
    assert.equal(
      (await memberProjectAccess(observingOwner, subject, signal, key))[project],
      "read",
    );
    assert.equal(accessSnapshots, 1, "The permission view reads one access snapshot");

    await useAccount(member);
    let oldKey: CryptoKey;
    let generationBeforeRevocation: string;
    try {
      const inventory = await required(
        memberClient.query("zerotrust.domains.list", undefined, fresh),
      );
      const expectedDomain = inventory.find(({ id }) => id === area.domain);
      assert.ok(expectedDomain, `The member can discover ${key}`);
      generationBeforeRevocation = expectedDomain.generation;
      assert.deepEqual(
        inventory.filter(({ id }) => probes.some(({ area }) => area.domain === id))
          .map(({ id }) => id),
        [area.domain],
        `Granting ${key} must only open that project's selected facet`,
      );

      await Promise.all(
        probes.filter((other) => other !== probe).map(async (other) => {
          const [value, error] = await memberClient.query(
            "zerotrust.keys.get", { domain: other.area.domain, generation: "1" }, fresh,
          );
          assert.equal(value, null);
          assert.equal(error?.code, "FORBIDDEN", `${key} must not open ${other.key}`);
        }),
      );

      const context = {
        tenant: member.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: expectedDomain.generation,
      };
      const readable = await protectedCollection(memberClient, area, signal);
      try {
        const entries = await readable.read();
        assert.deepEqual(entries.map(({ value }) => value), [{ text: initialText }]);
      } finally {
        readable.close();
      }
      const history = await trustedHistory(memberClient);
      const [definition, box, initial] = await Promise.all([
        required(memberClient.query("zerotrust.domains.get", {
          domain: area.domain, generation: context.generation,
        }, fresh)),
        required(memberClient.query("zerotrust.keys.get", {
          domain: area.domain, generation: context.generation,
        }, fresh)),
        required(memberClient.query("zerotrust.objects.get", { id: probe.initial }, fresh)),
      ]);
      const verified = await verifyDomain(definition, context, history.authority);
      const raw = await openBox(
        box,
        {
          tenant: context.tenant,
          purpose: "area-key",
          object: context.id,
          generation: context.generation,
          recipient: subject,
          author: box.author,
        },
        member.identity.encryptionKey.privateKey,
        await domainBoxSigner(verified, box, history.authority),
      );
      try {
        oldKey = await areaKey(raw);
      } finally {
        raw.fill(0);
      }

      const policy = await required(
        memberClient.query("zerotrust.policy.get", undefined, fresh),
      );
      const unauthorizedUpdate = await encryptObject(
        {
          ...contextOf(initial),
          revision: (BigInt(initial.revision) + 1n).toString(),
          generation: generationBeforeRevocation,
          author: subject,
          policyVersion: policy.version,
        },
        bytes(JSON.stringify({ text: declinedText })),
        oldKey,
        member.identity.signingKey.privateKey,
      );
      const [, refused] = await memberClient.mutate("zerotrust.objects.save", {
        domain: area.domain,
        messageId: crypto.randomUUID(),
        envelope: unauthorizedUpdate,
      });
      assert.ok(refused instanceof RpcClientError);
      assert.equal(refused.code, "FORBIDDEN", `A reader cannot update ${key}`);
    } finally {
      await useAccount(owner);
    }

    await changeProjectAccess(ownerClient, subject, project, "none", signal, key);
    const later = await write(probe, probe.later, laterText);
    assert.ok(
      BigInt(later.generation) > BigInt(generationBeforeRevocation),
      `The key for ${key} must rotate`,
    );
    await assert.rejects(() => decryptObject(
      later, contextOf(later), oldKey, owner.identity.signingKey.publicKey,
    ));
    const [newEnvelope, denied] = await memberClient.query(
      "zerotrust.objects.get", { id: probe.later }, fresh,
    );
    assert.equal(newEnvelope, null);
    assert.equal(denied?.code, "FORBIDDEN");

    const [historicalEnvelope, historyDenied] = await memberClient.query(
      "zerotrust.history.get", { id: probe.initial, revision: "1" }, fresh,
    );
    assert.equal(historicalEnvelope, null);
    assert.equal(historyDenied?.code, "FORBIDDEN", "A retained key does not bypass a revoked grant");

    await changeProjectAccess(ownerClient, subject, project, "read", signal, key);
    await useAccount(member);
    try {
      const collection = await protectedCollection(memberClient, area, signal);
      try {
        const entries = await collection.read();
        const actual = new Map(entries.map((entry) => [entry.envelope.object, entry.value]));
        assert.deepEqual(actual, new Map([
          [probe.initial, { text: initialText }],
          [probe.later, { text: laterText }],
        ]));
      } finally {
        collection.close();
      }
    } finally {
      await useAccount(owner);
    }
    await changeProjectAccess(ownerClient, subject, project, "none", signal, key);
    console.log(`Projektbereich ${key}: Freigabe, Entzug und erneute Freigabe geprüft`);
  }
}

async function exerciseProjectClosure(
  ownerClient: ReturnType<typeof createBusinessClient>,
  memberClient: Client,
  operator: Client,
  owner: UnlockedAccount,
  member: UnlockedAccount,
  project: string,
  destination: string,
  signal: AbortSignal,
  memberEndpoint: string,
) {
  const root = projectCollection(project);
  const files = fileCollection(project);
  console.log("Projektlöschung: Freigabe und persönliche Planung vorbereiten");
  await changeAreaActionAccesses(
    ownerClient,
    member.vault.subject,
    [{ area: root, patch: { read: true, delete: true } }],
    signal,
  );
  await required(ownerClient.mutate("projects.deployments.create", {
    projectId: project,
    userId: member.vault.subject.slice("user:".length),
    from: new Date("2026-11-23T07:00:00Z"),
    to: new Date("2026-11-23T12:00:00Z"),
  }));
  const file = await ownerClient.files.upload({
    projectId: project,
    name: "Unterlage zum Projektabschluss.txt",
    mime: "text/plain",
    blob: new Blob(["Verschlüsselter Projektanhang"], { type: "text/plain" }),
  });
  const object = fileObject(project, file);
  const room = { scope: files.scope, document: file, facet: "attachment" };
  async function bookTool(label: string) {
    const tool = await required(ownerClient.mutate("tools.create", {
      customId: await required(ownerClient.query("tools.suggestNextCustomId", undefined)),
      brand: "Projektausrüstung",
      category: "Baustellengerät",
      label,
    }));
    const booking = await required(ownerClient.mutate("tools.track", {
      id: tool.id,
      data: { projectId: project },
    }));
    return { id: tool.id, booking: booking.trackingId };
  }
  const drill = await bookTool("Bohrmaschine für Rückgabe");
  const lift = await bookTool("Arbeitsbühne für Übergabe");
  const transfer = await required(ownerClient.mutate("tools.trackings.transfers.request", {
    toolTrackingId: lift.booking,
    transferToUserId: member.vault.subject.slice("user:".length),
    projectId: destination,
  }));
  await required(ownerClient.query("zerotrust.documents.messages.state", room, fresh));
  const baseline = await required(ownerClient.query("zerotrust.access.snapshot", {}, fresh));
  const fileDomain = baseline.domains.find(({ id }) => id === files.domain);
  assert.ok(fileDomain);
  const policies = await required(ownerClient.query("zerotrust.policy.get", undefined, fresh));
  const administrator = await administratorContext(ownerClient, signal);
  const { permissions } = await readVerifiedPolicy(ownerClient, administrator);
  const staleProjectRole = await signPolicy(
    {
      ...permissions,
      version: (BigInt(permissions.version) + 1n).toString(),
      rules: replaceProjectRole(
        permissions.rules,
        member.vault.subject,
        project,
        "project-overview",
      ),
    },
    administrator.authority,
  );
  async function backup() {
    return required(operator.mutate("admin.storage.snapshots.create", {
      tenant: owner.tenant,
      operation: crypto.randomUUID(),
    }));
  }
  const before = await backup();
  console.log("Projektlöschung: konkurrierende Veröffentlichungen vorbereiten");
  const master = await protectedCollection(ownerClient, root, signal);
  const attachment = await protectedCollection(ownerClient, files, signal);
  let pending: { part: string; sequence: string };
  let blockId: string;
  try {
    await master.inspect();
    await attachment.inspect();
    const previous = await master.get(root.prefix);
    const payload = filePayload((await attachment.get(object)).value, object, project);
    assert.ok(payload.original?.parts[0]);
    blockId = payload.original.parts[0].id;
    const deletion = await master.tombstone(root.prefix, previous.envelope);
    const write = await attachment.packet(files.prefix + "closure-probe", { marker: true });
    const heads = [
      { domain: root.domain, sequence: master.snapshot() },
      { domain: files.domain, sequence: attachment.snapshot() },
    ];
    for (const objects of [[deletion, write], [write, deletion]]) {
      const [, error] = await ownerClient.mutate("zerotrust.objects.batch", { objects, heads });
      assert.ok(error instanceof RpcClientError);
      assert.equal(error.code, "CONFLICT");
    }
    const { id } = await required(ownerClient.mutate("zerotrust.objects.stage", {
      objects: [write],
    }));
    pending = { part: id, sequence: attachment.snapshot() };
  } finally {
    master.close();
    attachment.close();
  }

  await useAccount(member);
  console.log("Projektlöschung: Mitglied auf der zweiten API verbinden");
  let closureObserved = false;
  const business = createBusinessClient(memberClient, {
    productDriver: duckDriver,
    endpoint: memberEndpoint,
    realtime: true,
    onRemoteChange: (hint) => { closureObserved ||= hint.reset; },
  });
  try {
    assert.equal((await required(business.query("projects.get", { id: project }))).id, project);
    await assert.rejects(() => required(memberClient.query("zerotrust.objects.get", { id: object }, fresh)));
    const assignments = () => required(memberClient.query("zerotrust.objects.shared", {
      prefix: `schedule:${project}:deployment:`, after: null, snapshot: null,
    }, fresh));
    assert.equal((await assignments()).objects.length, 1);
    console.log("Projektlöschung: signierten Löschdatensatz veröffentlichen");
    assert.deepEqual(await required(business.mutate("projects.delete", { id: project })), { success: true });
    assert.deepEqual((await assignments()).objects, []);
    const deadline = Date.now() + 15_000;
    while (!closureObserved) {
      assert.ok(Date.now() < deadline, "The project closure must reset a member who only reads their personal assignment");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  } finally {
    business.dispose();
    await useAccount(owner);
  }

  const reply = await required(ownerClient.query("zerotrust.access.snapshot", {
    known: baseline.snapshot,
  }, fresh));
  assert.equal(reply.unchanged, false);
  assert.equal(reply.domains.some(({ id }) => id === files.domain), false);
  const [staleResult, staleError] = await ownerClient.mutate(
    "zerotrust.policy.replace",
    staleProjectRole,
  );
  assert.equal(staleResult, null, "A prepared role cannot grant access after the project was deleted");
  assert.ok(staleError instanceof RpcClientError);
  assert.equal(staleError.code, "FORBIDDEN");
  assert.equal((await required(ownerClient.query("zerotrust.policy.get", undefined, fresh))).signature, policies.signature);
  const confirmed = await required(ownerClient.query("zerotrust.objects.get", { id: root.prefix }, fresh));
  assert.equal(confirmed.format, TOMBSTONE_FORMAT);
  assert.equal(confirmed.author, member.vault.subject);

  const deletion = await required(ownerClient.query(
    "zerotrust.history.get", { id: root.prefix, revision: null }, fresh,
  ));
  assert.deepEqual(deletion?.envelope, confirmed);
  assert.ok(deletion?.previous);
  const previous = await required(ownerClient.query("zerotrust.history.get", {
    id: root.prefix, revision: deletion.previous.revision,
  }, fresh));
  assert.deepEqual(previous?.envelope, deletion.previous);

  const denied = await Promise.all([
    ownerClient.query("zerotrust.objects.get", { id: object }, fresh),
    ownerClient.query("zerotrust.objects.getMany", { domain: files.domain, ids: [object] }, fresh),
    ownerClient.query("zerotrust.objects.pages", { selections: [{
      domain: files.domain, prefix: files.prefix, after: null, snapshot: null,
    }] }, fresh),
    ownerClient.query("zerotrust.keys.get", {
      domain: files.domain, generation: fileDomain.generation,
    }, fresh),
    ownerClient.query("zerotrust.fileChunks.getMany", {
      domain: files.domain, ids: [blockId],
    }, fresh),
    ownerClient.query("zerotrust.documents.messages.state", room, fresh),
    ownerClient.mutate("zerotrust.objects.commit", {
      parts: [pending.part],
      heads: [{ domain: files.domain, sequence: pending.sequence }],
    }),
  ]);
  for (const [value, error] of denied) {
    assert.equal(value, null);
    assert.ok(error instanceof RpcClientError);
    assert.equal(error.code, "FORBIDDEN");
  }
  console.log("Projektlöschung: Sicherungen von vor und nach der Löschung prüfen");
  async function inspect(snapshotOperation: string) {
    const prepared = await required(ownerClient.mutate("zerotrust.content.prepare", {
      snapshotOperation, operation: crypto.randomUUID(),
    }));
    const approval = await approvePreparedContent(ownerClient, prepared, signal);
    return {
      prepared: { operation: approval.operation, approval: approval.approval },
      review: await inspectPreparedContent(ownerClient, approval, signal),
    };
  }
  const older = await inspect(before.id);
  const block = { domain: files.domain, ids: [blockId], prepared: older.prepared };
  const saved = await required(
    ownerClient.query("zerotrust.fileChunks.getMany", block, fresh),
  );
  assert.equal(saved.length, 1);
  const [tampered, nonAdministrator] = await Promise.all([
    ownerClient.query("zerotrust.fileChunks.getMany", {
      ...block,
      prepared: { ...older.prepared, operation: crypto.randomUUID() },
    }, fresh),
    memberClient.query("zerotrust.fileChunks.getMany", block, fresh),
  ]);
  const closed = await inspect((await backup()).id);
  assert.equal(older.review.projects - closed.review.projects, 1);
  assert.equal(older.review.restoredFiles.files - closed.review.restoredFiles.files, 1);
  assert.equal(closed.review.missingPlanningReferences, 0);
  const closedView = await ownerClient.query(
    "zerotrust.fileChunks.getMany",
    { ...block, prepared: closed.prepared },
    fresh,
  );
  for (const [[value, error], expected] of [
    [tampered, "CONFLICT"],
    [nonAdministrator, "FORBIDDEN"],
    [closedView, "FORBIDDEN"],
  ] as const) {
    assert.equal(value, null);
    assert.ok(error instanceof RpcClientError);
    assert.equal(error.code, expected);
  }
  console.log("Projektlöschung: Rückgabe, Werkzeugpreise und Umbuchung prüfen");
  await required(ownerClient.mutate("tools.update", {
    id: drill.id,
    data: { usageCostPerDay: 27.5 },
  }));
  await required(ownerClient.mutate("tools.untrack", {
    id: drill.id,
    expectedTrackingId: drill.booking,
  }));
  const history = await required(ownerClient.query("tools.trackings.list", {
    toolId: drill.id,
    finished: true,
  }));
  assert.equal(history[0]?.toolUsageCostPerDay, 27.5);
  assert.equal(history[0]?.projectId, project);
  await required(ownerClient.mutate("tools.delete", { id: drill.id }));
  await required(ownerClient.mutate("tools.trackings.transfers.accept", {
    id: transfer.id,
    projectId: destination,
  }));
  const activeBookings = await required(ownerClient.query("tools.trackings.list", {
    toolId: lift.id,
    finished: false,
  }));
  assert.equal(activeBookings[0]?.projectId, destination);
  console.log("Projektlöschung sperrt Anhang, Schlüssel, Live-Kanal und vorbereitete Speicherung auf der anderen API");
}

export async function exerciseProjectAccess(
  ownerClient: ReturnType<typeof createBusinessClient>,
  memberClient: Client,
  operator: Client,
  memberEndpoint: string,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const owner = unlockedAccount();
  assert.ok(owner);
  const username = "project.member";
  const password = "Disposable-project-member-password-2026!";
  const projectTitle = "Vertrauliches Bauvorhaben für Bereichsprüfung 342719";
  const closureTitle = "Vertrauliche Baustelle zur Projektlöschung 547913";
  try {
    const project = await required(ownerClient.mutate("projects.create", {
      title: projectTitle,
    }));
    const id = projectCollection(project.id).prefix;
    const first = await required(ownerClient.query(
      "zerotrust.history.get", { id, revision: "1" }, fresh,
    ));
    const latest = await required(ownerClient.query(
      "zerotrust.history.get", { id, revision: null }, fresh,
    ));

    assert.ok(first);
    assert.equal(first.envelope.object, id);
    assert.equal(first.envelope.revision, "1");
    assert.equal(first.publication, first.initialPublication);
    assert.equal(first.previous, null);
    assert.deepEqual(latest, first);

    const user = await required(ownerClient.mutate("users.create", {
      username,
      firstName: "Projekt",
      lastName: "Mitarbeiter",
      email: null,
      phone: null,
      vacationDaysPerYear: 28,
      costPerHour: 42,
      contractType: "internal",
      supervisorUserId: null,
    }));
    const invitation = await createMemberInvitation(
      ownerClient, { id: user.id, username },
      {
        catalogue: "none", customers: "none", contacts: "none",
        vendors: "none", prices: "none", assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(memberClient, invitation.link, password, signal);
    const member = unlockedAccount();
    assert.ok(member);
    await useAccount(owner);
    const lease = acquireDataRuntime(ownerClient, signal, duckDriver);
    try {
      await approveMemberInvitation(ownerClient, invitation.link.invitation.id, signal);
    } finally {
      lease.close();
    }
    await testProjectModulePermissions(
      ownerClient, memberClient, owner, member, project.id, signal, PROJECT_ACCESS_KEYS,
    );
    // The rotation test deliberately denied each facet. The closure test
    // needs a fresh project where the person's derived planning grant applies.
    const closing = await required(ownerClient.mutate("projects.create", {
      title: closureTitle,
    }));
    await exerciseProjectClosure(
      ownerClient, memberClient, operator, owner, member, closing.id, project.id, signal, memberEndpoint,
    );
    return {
      closedProject: closing.id,
      privateValues: [projectTitle, closureTitle, initialText, laterText, declinedText, password],
    };
  } finally {
    controller.abort();
    await useAccount(owner);
  }
}
