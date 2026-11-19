import assert from "node:assert/strict";
import { RpcClientError, type Client, type QueryResult } from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  decryptObject,
  domainBoxSigner,
  encryptObject,
  openBox,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  trustedHistory,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  changeProjectAccess,
  memberProjectAccess,
} from "../app/lib/crypto/permissions";
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

export async function exerciseProjectAccess(ownerClient: Client, memberClient: Client) {
  const controller = new AbortController();
  const signal = controller.signal;
  const owner = unlockedAccount();
  assert.ok(owner);
  const username = "project.member";
  const password = "Disposable-project-member-password-2026!";
  const projectTitle = "Vertrauliches Bauvorhaben für Bereichsprüfung 342719";
  try {
    const project = await required(ownerClient.mutate("projects.create", {
      title: projectTitle,
    }));
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
    return [projectTitle, initialText, laterText, declinedText, password];
  } finally {
    controller.abort();
    await useAccount(owner);
  }
}
