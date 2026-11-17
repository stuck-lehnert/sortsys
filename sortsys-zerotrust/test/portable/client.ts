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
  preparePayload,
  assemblePayload,
  migrationSealFrame,
  sign,
  signResourceAccess,
  verifyResourceAccess,
  OpenTimestampUnavailable,
  publicIdentity,
  record,
  reserveRecoveryInventory,
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
  const inventory = reserveRecoveryInventory(
    { domains: 2, keyGenerations: 10_001 },
    { domains: 0, keyGenerations: 2 },
  );
  const payloadText = "Öffentlicher Laborbericht 🏗️\n".repeat(6000);
  const payload = preparePayload(payloadText, {
    context: "laboratory:alpha",
    operation: "restore:17",
  });
  require(payload.parts.length > 1);
  require(assemblePayload(payload.manifest, payload.parts) === payloadText);
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
  const accessState = await signResourceAccess(
    {
      tenant: context.tenant,
      resource: context.scope,
      object: context.object,
      revision: context.revision,
      generation: "1",
      binding: base64(new Uint8Array(32).fill(7)),
      active: true,
      packetSignature: object.signature,
      author: delegation.readers[0]!,
    },
    identity.signingKey.privateKey,
  );
  await verifyResourceAccess(
    accessState,
    {
      tenant: context.tenant,
      resource: context.scope,
      object: context.object,
      generation: "1",
      binding: base64(new Uint8Array(32).fill(7)),
    },
    () => identity.signingKey.publicKey,
  );
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
  const administrationRoot = await security.policies.signPolicy(
    {
      tenant: context.tenant,
      version: "2",
      rules: [
        {
          subject: context.author,
          scope: context.scope,
          facet: context.facet,
          actions: ["read", "update", "grant"],
          effect: "allow",
        },
        {
          subject: delegation.creator.user,
          scope: context.scope,
          facet: context.facet,
          actions: ["read", "update", "grant"],
          effect: "allow",
        },
        {
          subject: "researcher:ada",
          scope: "preferences:ada",
          facet: context.facet,
          actions: ["read", "update", "grant"],
          effect: "allow",
        },
      ],
    },
    identity.signingKey.privateKey,
  );
  const profile = await security.policies.administrativeProfiles.sign(
    {
      tenant: context.tenant,
      rootSignature: administrationRoot.signature,
      version: "3",
      subject: "researcher:ada",
      scope: context.scope,
      facet: context.facet,
      actions: ["read", "update"],
      author: delegation.creator,
    },
    delegate.signingKey.privateKey,
  );
  const keyAuthority = await security.keyAuthorities.certify(
    {
      tenant: context.tenant,
      generation: "1",
      scope: context.scope,
      facet: context.facet,
      holder: delegation.creator,
    },
    identity.signingKey.privateKey,
  );
  const managedDomain = await security.domains.createManagedDomain({
    tenant: context.tenant,
    id: `${context.scope}:${context.facet}`,
    scope: context.scope,
    facet: context.facet,
    generation: "2",
    policyVersion: "3",
    keyAuthority,
    signingKey: delegate.signingKey.privateKey,
    recovery: await publicIdentity(identity),
    readers: [
      { subject: delegation.creator.user, identity: delegation.creator },
    ],
  });
  const administrativePolicy = await security.policies.signAdministrativePolicy(
    {
      root: administrationRoot,
      profiles: [profile],
      author: delegation.creator,
      previousSignature: administrationRoot.signature,
      version: "3",
    },
    delegate.signingKey.privateKey,
  );
  const checkedAdministration = await security.policies.verifyPolicy(
    administrativePolicy,
    { tenant: context.tenant, authority: identity.signingKey.publicKey },
  );
  const unchangedAdministration =
    await security.policies.signAdministrativePolicy(
      {
        ...administrativePolicy.administration!,
        previousSignature: administrativePolicy.signature,
        version: "4",
      },
      delegate.signingKey.privateKey,
    );
  require(
    security.policies
      .compilePolicy(checkedAdministration.permissions, ["researcher:ada"])
      .allows(context.scope, context.facet, "update"),
  );
  const administrationRevoked = await security.policies.signPolicy(
    {
      ...checkedAdministration.permissions,
      version: "4",
      rules: checkedAdministration.permissions.rules.map((rule) =>
        rule.subject === delegation.creator.user
          ? {
              ...rule,
              actions: rule.actions.filter((action) => action !== "grant"),
            }
          : rule,
      ),
    },
    identity.signingKey.privateKey,
  );
  const staleAdministration = await security.policies.signAdministrativePolicy(
    {
      ...administrativePolicy.administration!,
      previousSignature: administrationRevoked.signature,
      version: "5",
    },
    delegate.signingKey.privateKey,
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
    inventory,
    payload: { ...payload, content: payloadText },
    signer: (await publicIdentity(identity)).signingKey,
    delegation,
    accessState,
    object,
    policy,
    administrativePolicy,
    unchangedAdministration,
    managedDomain: managedDomain.definition,
    administrationRevoked,
    staleAdministration,
    permanent,
    packetDigest,
    migration,
    proof: base64(proof),
    anchored,
    replacement,
    anchorDigest: await anchorFingerprint(replacement),
  };
}
