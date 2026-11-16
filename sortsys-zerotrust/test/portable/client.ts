import {
  areaKey,
  advanceRecordAnchor,
  anchorFingerprint,
  base64,
  bytes,
  certifyIdentity,
  createDelegationCodec,
  createIdentity,
  createZeroTrust,
  digest,
  immutableObject,
  immutableWriteAction,
  InvalidProtectedData,
  MigrationInventory,
  migrationSealFrame,
  sign,
  OpenTimestampUnavailable,
  publicIdentity,
  record,
  serializeOtsTree,
  signedPacketFrame,
  sized,
  stampOtsDigest,
  VerifiedStore,
} from "@sortsys/zerotrust";

function require(condition: unknown): asserts condition {
  if (!condition) throw new Error("Portable framework assertion failed");
}

export async function exerciseFramework() {
  const security = createZeroTrust({
    facets: ["research-notes", "appointments"],
  });
  const identity = await createIdentity();
  const delegate = await createIdentity();
  const delegations = createDelegationCodec(["experiment", "appointment"]);
  const delegation = await delegations.certify(
    {
      tenant: "laboratory:alpha",
      id: "delegation:experiment42",
      generation: "1",
      namespace: "experiment",
      creator: await certifyIdentity(
        {
          tenant: "laboratory:alpha",
          generation: "1",
          user: "researcher:kai",
          ...(await publicIdentity(delegate)),
        },
        identity.signingKey.privateKey,
      ),
      readers: [
        await certifyIdentity(
          {
            tenant: "laboratory:alpha",
            generation: "1",
            user: "researcher:lee",
            ...(await publicIdentity(identity)),
          },
          identity.signingKey.privateKey,
        ),
      ],
    },
    identity.signingKey.privateKey,
  );
  await delegations.verify(
    delegation,
    {
      tenant: "laboratory:alpha",
      generation: "1",
      namespace: "experiment",
      creator: "researcher:kai",
    },
    identity.signingKey.publicKey,
  );
  const key = await areaKey();
  const context = {
    tenant: "laboratory:alpha",
    scope: "experiment:42",
    facet: "research-notes" as const,
    object: "note:1",
    revision: "1",
    generation: "1",
    policyVersion: "1",
    author: "researcher:lee",
  };
  const store = new VerifiedStore({
    objects: security.objects,
    context,
    schema: {
      decode(input: unknown) {
        const value = record(input, ["observation"]);
        if (typeof value.observation !== "string")
          throw new InvalidProtectedData();
        return { observation: value.observation };
      },
    },
    key: async () => key,
    signer: async () => identity.signingKey.publicKey,
  });
  const object = await store.encrypt(
    context,
    { observation: "Sample remains stable" },
    key,
    identity.signingKey.privateKey,
  );
  const first = await store.receive(context.object, object);
  require(
    first.kind === "verified" &&
      first.current.value.observation === "Sample remains stable",
  );

  const invalid = await security.objects.encryptObject(
    { ...context, revision: "2" },
    bytes('{"observation":42}'),
    key,
    identity.signingKey.privateKey,
  );
  const rejected = await store.receive(context.object, invalid);
  require(rejected.kind === "invalid" && rejected.lastGood?.revision === "1");

  const policy = await security.policies.signPolicy(
    {
      tenant: context.tenant,
      version: "1",
      rules: [
        {
          subject: context.author,
          scope: context.scope,
          facet: context.facet,
          actions: ["read", "update"],
          effect: "allow",
        },
      ],
    },
    identity.signingKey.privateKey,
  );
  const checked = await security.policies.verifyPolicy(policy, {
    tenant: context.tenant,
    authority: identity.signingKey.publicKey,
  });
  const permissions = security.policies.compilePolicy(checked.permissions, [
    context.author,
  ]);
  require(permissions.allows(context.scope, context.facet, "update"));
  require(!permissions.allows(context.scope, context.facet, "delete"));

  const permanent = await security.objects.encryptObject(
    {
      ...context,
      object: immutableObject(
        context.scope,
        context.facet,
        "record",
        "sample-42",
      ),
    },
    bytes('{"observation":"Final result"}'),
    key,
    identity.signingKey.privateKey,
  );
  require(immutableWriteAction(permanent) === "create");
  const packetDigest = await digest(
    signedPacketFrame(
      security.objects.objectFrame(permanent),
      permanent.signature,
    ),
  );
  const digestBytes = sized(packetDigest, 32);
  const calendar = "https://alice.btc.calendar.opentimestamps.org";
  const proof = await stampOtsDigest(digestBytes, {
    calendars: [calendar],
    async fetch(url, options) {
      require(url === calendar + "/digest");
      require(options.body instanceof Uint8Array && options.body.length === 32);
      require(base64(Uint8Array.from(options.body)) !== packetDigest);
      const name = bytes(calendar);
      return new Response(
        serializeOtsTree({
          attestations: [
            {
              tag: new Uint8Array([
                0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e,
              ]),
              payload: new Uint8Array([name.length, ...name]),
            },
          ],
          edges: [],
        }),
      );
    },
  });

  let unavailable = false;
  try {
    await stampOtsDigest(digestBytes, {
      calendars: [calendar],
      async fetch() {
        throw new Error("Calendar offline");
      },
    });
  } catch (error) {
    require(error instanceof OpenTimestampUnavailable);
    unavailable = true;
  }
  require(unavailable && immutableWriteAction(permanent) === "create");
  let updateRejected = false;
  try {
    immutableWriteAction({ ...permanent, revision: "2" });
  } catch (error) {
    require(error instanceof InvalidProtectedData);
    updateRejected = true;
  }
  require(updateRejected);
  const sourceInventory = new MigrationInventory();
  sourceInventory.add({
    kind: "record",
    id: context.object,
    revision: object.revision,
    hash: await digest(
      signedPacketFrame(security.objects.objectFrame(object), object.signature),
    ),
  });
  const targetInventory = new MigrationInventory();
  targetInventory.add({
    kind: "record",
    id: permanent.object,
    revision: permanent.revision,
    hash: packetDigest,
  });
  const unsignedSeal = {
    tenant: context.tenant,
    migration: "migration:lab:1",
    schema: "lab-schema:1",
    generation: "1",
    policyVersion: "1",
    catalogVersion: "1",
    source: sourceInventory.finish(),
    target: targetInventory.finish(),
    author: context.author,
  };
  const migration = {
    ...unsignedSeal,
    proof: await sign(
      identity.signingKey.privateKey,
      migrationSealFrame(unsignedSeal),
    ),
  };
  store.lock();
  const anchored = await advanceRecordAnchor(
    "public laboratory key certificate",
  );
  const replacement = await advanceRecordAnchor(
    "replacement laboratory key certificate",
    anchored,
  );
  return {
    signer: (await publicIdentity(identity)).signingKey,
    delegation,
    object,
    policy,
    permanent,
    packetDigest,
    migration,
    proof: base64(proof),
    anchored,
    replacement,
    anchorDigest: await anchorFingerprint(replacement),
  };
}
