import { RpcClientError } from "@sortsys/v2-client";
import {
  ACTIONS,
  base64,
  bytes,
  createAccountVault,
  createDomain,
  createIdentity,
  createTenantSetup,
  decryptObject,
  domainProof,
  encryptObject,
  publicIdentity,
  signInitializationSource,
  signPolicy,
  stockKind,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { stockPacket } from "../stockObjects";
import { accessSnapshotFixture } from "./accessSnapshot.mjs";
import { acceptVault } from "../../crypto/session";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
function compareText(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
/** Protocol fixture using real envelopes, signatures, area keys and policies.
 * Atomic head conflicts are simulated; it is not a native multi-API test. */
export async function protectedTenant(
  areas,
  actions = () => [...ACTIONS],
  options = {},
) {
  const identity = await createIdentity();
  const subject = "user:1";
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    subject,
    identity,
    PHRASE,
    {
      ...(options.backup
        ? { context: `backup:${base64(new Uint8Array(32).fill(19))}` }
        : {}),
      scopes: areas.map((area) => ({
        scope: area.scope,
        facet: area.facet,
        actions: actions(area),
      })),
    },
  );
  const source = options.backup
    ? await signInitializationSource(
        {
          tenant: "test",
          context: setup.authority.context,
          generation: "1",
          author: subject,
          manifest: `${setup.authority.context}:manifest`,
          objectSignature: base64(new Uint8Array(64).fill(4)),
        },
        authorityKey.privateKey,
      )
    : null;
  const { signature, ...unsigned } = setup.policy;
  let policy = await signPolicy(
    {
      ...unsigned,
      version: "2",
      rules: unsigned.rules
        .map((rule) => {
          const area = areas.find(
            (area) => area.scope === rule.scope && area.facet === rule.facet,
          );
          return area ? { ...rule, actions: actions(area) } : rule;
        })
        .filter((rule) => rule.actions.length),
    },
    authorityKey.privateKey,
  );
  const policies = new Map([
    ["1", setup.policy],
    ["2", policy],
  ]);
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(
    exportKey,
    await createAccountVault(exportKey, "test", "user:1", identity, {
      recoveryGeneration: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    }),
    "owner",
    false,
  );
  const domains = new Map();
  const objects = new Map();
  const chunks = new Map();
  const stocks = new Map();
  const calls = [];
  const deliveryAllocations = new Map();
  for (const area of areas) {
    if (!domains.has(area.domain)) {
      const made = await createDomain({
        tenant: "test",
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: "1",
        policyVersion: "1",
        authorityGeneration: "1",
        authorityKey: authorityKey.privateKey,
        recovery: {
          encryptionKey: setup.authority.recoveryEncryptionKey,
          signingKey: setup.authority.recoverySigningKey,
        },
        readers: [{ subject, identity: await publicIdentity(identity) }],
      });
      domains.set(area.domain, { area, ...made, head: 0 });
    }
  }
  const state = {
    loseReply: false,
    discardCommit: false,
    roles: [],
    beforeCommit: async () => {},
    beforeChunk: async () => {},
    loseChunkReply: false,
    discardChunk: false,
  };
  const conflict = () => [
    null,
    Object.assign(new Error("Simulated concurrent API commit"), {
      code: "CONFLICT",
    }),
  ];
  const client = {
    loggedIn: () => true,
    listenAuthState: () => () => {},
    async invalidate() {},
    async query(path, input) {
      calls.push({ path, input: structuredClone(input) });
      switch (path) {
        case "zerotrust.access.snapshot":
        case "zerotrust.access.page":
          return accessSnapshotFixture(client, input);
        case "zerotrust.documents.messages.state":
          return [{ current: "0", checkpoint: null }, null];
        case "zerotrust.status":
          return [
            {
              tenant: "test",
              phase: "active",
              profile: setup,
              initialization: null,
            },
            null,
          ];
        case "zerotrust.setup.backup.status":
          return [
            {
              context: setup.authority.context ?? null,
              source,
              completion: null,
            },
            null,
          ];
        case "auth.sessionInfo":
          return [
            {
              user: { id: "1", username: "owner", locale: "de" },
              roles: state.roles,
            },
            null,
          ];
        case "zerotrust.trust.history":
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        case "zerotrust.policy.get":
          return [policy, null];
        case "zerotrust.policy.getVersion":
          return policies.has(input.version)
            ? [{ generation: "1", policy: policies.get(input.version) }, null]
            : [null, new Error("Missing policy")];
        case "zerotrust.creations.list":
          return [[], null];
        case "zerotrust.creations.origin":
          return [null, null];
        case "zerotrust.domains.list":
          return [
            [...domains].map(([id, domain]) => ({
              id,
              scope: domain.area.scope,
              facet: domain.area.facet,
              generation: "1",
              rotationRequired: false,
            })),
            null,
          ];
        case "zerotrust.domains.get":
          return [domains.get(input.domain).definition, null];
        case "zerotrust.domains.proof": {
          const domain = domains.get(input.domain);
          if (!domain) {
            return [null, new Error("Missing public domain proof")];
          }
          return [await domainProof(domain.definition), null];
        }
        case "zerotrust.keys.get":
          return [domains.get(input.domain).definition.envelopes[0], null];
        case "zerotrust.keys.history": {
          const definition = domains.get(input.domain).definition;
          return [
            input.generations.map((generation) => ({
              generation,
              definition,
              envelope: definition.envelopes[0] ?? null,
            })),
            null,
          ];
        }
        case "zerotrust.stock.references":
          return [
            input.objects.map((object) => ({
              object,
              references: stocks.get(object),
              vendorDeletion: null,
            })),
            null,
          ];
        case "zerotrust.deliveryNotes.references":
          return [
            input.objects.map((object) => ({
              object,
              allocation: structuredClone(deliveryAllocations.get(object)),
            })),
            null,
          ];
        case "zerotrust.objects.get":
          return objects.has(input.id)
            ? [structuredClone(objects.get(input.id)), null]
            : [
                null,
                Object.assign(new Error("Missing"), { code: "NOT_FOUND" }),
              ];
        case "zerotrust.fileChunks.get": {
          const saved = chunks.get(input.id);
          if (!saved || saved.domain !== input.domain) {
            return [
              null,
              new RpcClientError({
                message: "Missing file block",
                code: -32004,
                data: { code: "NOT_FOUND", httpCode: 404 },
              }),
            ];
          }
          return [structuredClone(saved.envelope), null];
        }
        case "zerotrust.objects.list": {
          const domain = domains.get(input.domain);
          const head = String(domain.head);
          if (input.snapshot != null && input.snapshot !== head) {
            return conflict();
          }
          if (input.headOnly) {
            if (input.snapshot == null) {
              return [null, new Error("Head check requires a known snapshot")];
            }
            return [
              { snapshot: head, keyGeneration: "1", after: null, objects: [] },
              null,
            ];
          }
          const values = [...objects.values()]
            .filter(
              (item) =>
                item.scope === domain.area.scope &&
                item.facet === domain.area.facet &&
                item.object.startsWith(input.prefix) &&
                (input.after == null || item.object > input.after),
            )
            .sort((left, right) => compareText(left.object, right.object));
          return [
            {
              snapshot: head,
              keyGeneration: "1",
              after: values.length > 32 ? values[31].object : null,
              objects: structuredClone(values.slice(0, 32)),
            },
            null,
          ];
        }
        case "zerotrust.objects.pages": {
          const pages = [];
          for (const selection of input.selections) {
            const [page, error] = await client.query(
              "zerotrust.objects.list",
              selection,
            );
            if (error) return [null, error];
            pages.push(page);
          }
          return [pages, null];
        }
        default:
          throw new Error("Unexpected query " + path);
      }
    },
    async mutate(path, input) {
      calls.push({ path, input: structuredClone(input) });
      if (path === "zerotrust.fileChunks.put") {
        await state.beforeChunk();
        const previous = chunks.get(input.envelope.object);
        if (previous && JSON.stringify(previous) !== JSON.stringify(input))
          return conflict();
        if (!state.discardChunk)
          chunks.set(input.envelope.object, structuredClone(input));
        if (state.loseChunkReply)
          return [null, new Error("Lost file block acknowledgement")];
        return [{ success: true }, null];
      }
      if (path !== "zerotrust.objects.batch") {
        throw new Error("Unexpected mutation " + path);
      }
      await state.beforeCommit();
      if (
        input.heads.some(
          (head) => String(domains.get(head.domain).head) !== head.sequence,
        )
      ) {
        return conflict();
      }
      if (input.policy) {
        const checked = await verifyPolicy(input.policy, {
          tenant: "test",
          authority: authorityKey.publicKey,
        });
        if (
          checked.transaction?.previousSignature !== policy.signature ||
          BigInt(checked.permissions.version) !== BigInt(policy.version) + 1n ||
          JSON.stringify(checked.transaction.packets) !==
            JSON.stringify(
              input.objects.map((packet) => packet.envelope.signature).sort(),
            ) ||
          JSON.stringify(checked.transaction.heads) !==
            JSON.stringify(
              [...input.heads].sort((left, right) =>
                compareText(left.domain, right.domain),
              ),
            )
        ) {
          return conflict();
        }
      }
      for (const packet of input.objects) {
        const previous = objects.get(packet.envelope.object);
        if (
          BigInt(packet.envelope.revision) !==
          BigInt(previous?.revision ?? "0") + 1n
        ) {
          return conflict();
        }
      }
      if (state.discardCommit) {
        return [{ success: true }, null];
      }
      for (const packet of input.objects) {
        objects.set(packet.envelope.object, structuredClone(packet.envelope));
        if (packet.references) {
          stocks.set(
            packet.envelope.object,
            structuredClone(packet.references),
          );
        }
      }
      if (input.policy) {
        policy = structuredClone(input.policy);
        policies.set(policy.version, policy);
      }
      for (const domain of new Set(
        input.objects.map((packet) => packet.domain),
      )) {
        domains.get(domain).head++;
      }
      if (state.loseReply) {
        throw new Error("Lost acknowledgement after atomic commit");
      }
      return [
        {
          success: true,
          heads: [...new Set(input.objects.map((packet) => packet.domain))].map(
            (domain) => ({
              domain,
              sequence: String(domains.get(domain).head),
            }),
          ),
        },
        null,
      ];
    },
  };
  async function seed(area, id, value) {
    if (value.format === "sortsys-delivery-note-v1") {
      const note = value.note.values;
      deliveryAllocations.set(id, {
        id: BigInt(note.id).toString(32),
        projectId: BigInt(note.project_id).toString(32),
        number: note.auto_id,
      });
    }
    const domain = domains.get(area.domain);
    const previous = objects.get(id);
    const envelope = await encryptObject(
      {
        tenant: "test",
        scope: area.scope,
        facet: area.facet,
        object: id,
        revision: String(BigInt(previous?.revision ?? "0") + 1n),
        generation: "1",
        policyVersion: "1",
        author: subject,
      },
      bytes(JSON.stringify(value)),
      domain.key,
      identity.signingKey.privateKey,
    );
    if (stockKind(id)) {
      stocks.set(
        id,
        await stockPacket(envelope, value, "1", identity.signingKey.privateKey),
      );
    }
    objects.set(id, envelope);
    domain.head++;
    return envelope;
  }
  async function plain(area, id) {
    const envelope = objects.get(id);
    const opened = await decryptObject(
      envelope,
      Object.fromEntries(
        [
          "tenant",
          "scope",
          "facet",
          "object",
          "revision",
          "generation",
          "policyVersion",
          "author",
        ].map((key) => [key, envelope[key]]),
      ),
      domains.get(area.domain).key,
      identity.signingKey.publicKey,
    );
    return JSON.parse(new TextDecoder().decode(opened));
  }
  async function addArea(area, actions = [...ACTIONS]) {
    if (domains.has(area.domain)) throw new Error("Test area already exists");
    const made = await createDomain({
      tenant: "test",
      id: area.domain,
      scope: area.scope,
      facet: area.facet,
      generation: "1",
      policyVersion: policy.version,
      authorityGeneration: "1",
      authorityKey: authorityKey.privateKey,
      recovery: {
        encryptionKey: setup.authority.recoveryEncryptionKey,
        signingKey: setup.authority.recoverySigningKey,
      },
      readers: [{ subject, identity: await publicIdentity(identity) }],
    });
    domains.set(area.domain, { area, ...made, head: 0 });
    const { signature, ...previous } = policy;
    policy = await signPolicy(
      {
        ...previous,
        version: (BigInt(policy.version) + 1n).toString(),
        rules: [
          ...policy.rules,
          {
            subject,
            scope: area.scope,
            facet: area.facet,
            actions,
            effect: "allow",
          },
        ],
      },
      authorityKey.privateKey,
    );
    policies.set(policy.version, policy);
  }
  return {
    client,
    calls,
    domains,
    objects,
    chunks,
    state,
    seed,
    plain,
    addArea,
    identity,
    authorityKey,
    setup,
  };
}
