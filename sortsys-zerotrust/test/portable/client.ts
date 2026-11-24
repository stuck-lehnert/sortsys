import {
  areaKey,
  advanceRecordAnchor,
  anchorFingerprint,
  base64,
  bytes,
  certifyIdentity,
  credentialIdentifier,
  createAccountVault,
  createCursorHistory,
  createDelegationCodec,
  createIdentity,
  createResourceCommandKey,
  createScopedResource,
  createZeroTrust,
  digest,
  objectKeyRecipientBinding,
  findAvailableNumber,
  immutableObject,
  immutableWriteAction,
  InvalidProtectedData,
  latestQuery,
  mapConcurrent,
  pendingReads,
  MigrationInventory,
  preparePayload,
  assemblePayload,
  migrationSealFrame,
  openResourceCommandSigner,
  resourceCommandBinding,
  sign,
  signResourceAccess,
  signResourceCommand,
  verifyResourceAccess,
  verifyResourceCommand,
  OpenTimestampUnavailable,
  publicIdentity,
  passkeyDeletionFrame,
  passkeyRegistrationFrame,
  registrationCredentialFrame,
  routingUserHandle,
  record,
  reserveRecoveryInventory,
  serializeOtsTree,
  sized,
  stampOtsDigest,
  VerifiedStore,
  signContentEpoch,
  signContentReview,
  contentEpochFrame,
  contentEpochFingerprint,
  contentEpochFollows,
  namespaceRecord,
  logicalRecord,
  contentPin,
  contentPinKey,
} from "@sortsys/zerotrust";

function require(condition: unknown): asserts condition {
  if (!condition) throw new Error("Portable framework assertion failed");
}

async function exerciseScopedResource() {
  let controller = new AbortController();
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const closed: string[] = [];
  let opened = 0;
  const resource = createScopedResource({
    signal: () => controller.signal,
    assertActive: () => controller.signal.throwIfAborted(),
    expired: () => new Error("Scope changed"),
    open: () => (++opened === 1 ? pending : "current workspace"),
    close: (value) => {
      closed.push(value);
    },
  });

  require(resource.getIfOpen() === null);
  const previous = resource.get().then(() => false, () => true);
  await Promise.resolve();
  require(opened === 1);

  resource.reset();
  controller.abort();
  controller = new AbortController();
  require(resource.getIfOpen() === null);
  require(await resource.get() === "current workspace");

  finish("previous workspace");
  require(await previous);
  require(closed.join() === "previous workspace");
  resource.reset();
  await Promise.resolve();
  require(closed.join() === "previous workspace,current workspace");
}

export async function exerciseFramework() {
  await exerciseScopedResource();

  let reads = 0;
  const latestPage = await new Promise<number>((resolve, reject) => {
    const query = latestQuery(
      async () => {
        const page = ++reads;
        // A new snapshot arrives while the first read is in progress.
        if (page === 1) query.refresh();
        return page;
      },
      (page) => {
        query.close();
        resolve(page);
      },
      reject,
    );
    query.refresh();
  });
  require(latestPage === 2 && reads === 2);

  const directory = createCursorHistory([{ id: "recent-sample" }], 1);
  await directory.loadOlder(async (cursor) => {
    require(cursor === "recent-sample");
    return [{ id: "earlier-sample" }];
  });
  require(directory.getSnapshot().items.map(({ id }) => id).join() ===
    "recent-sample,earlier-sample");

  let fetchCount = 0;
  const samples = pendingReads<{ page: number }>(
    async () => ({ page: ++fetchCount }),
    structuredClone,
  );
  const [samplePage, duplicatePage] = await Promise.all([
    samples.get("samples", { offset: 20n }),
    samples.get("samples", { offset: 20n }),
  ]);
  require(samplePage.page === 1 && duplicatePage.page === 1);
  require(samplePage !== duplicatePage);
  require((await samples.get("samples", { offset: 20n })).page === 2);

  const redactedSamples = new Set(["lab:sample-9007199254740993"]);
  const sample = await findAvailableNumber({
    start: 1n,
    next: 9007199254740993n,
    max: 9007199254740994n,
    format: (counter) => `sample-${counter}`,
    address: async (number) => `lab:${number}`,
    occupied: async ({ object }) => redactedSamples.has(object),
  });
  require(sample?.number === "sample-9007199254740994");
  require(sample.nextNumber === "9007199254740995");

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

  const inbox = new Map(payload.parts.map((part, index) => [index, part]));
  const restored = await mapConcurrent(payload.parts, 2, async (_, index) => {
    const part = inbox.get(index);
    require(part !== undefined);
    return part;
  });
  require(assemblePayload(payload.manifest, restored) === payloadText);

  const security = createZeroTrust({
    facets: ["research-notes", "appointments"],
  });
  const identity = await createIdentity();
  const passkeyCredential = {
    id: base64(new Uint8Array([19, 42, 87])),
    rawId: base64(new Uint8Array([19, 42, 87])),
    type: "public-key" as const,
    response: {
      clientDataJSON: base64(bytes("portable public client data")),
      attestationObject: base64(new Uint8Array([0xa0])),
    },
    transports: ["internal", "hybrid"],
  };
  const passkeyBinding = {
    tenant: "laboratory:alpha",
    subject: "researcher:kai",
    userHandle: await routingUserHandle(
      "laboratory:alpha",
      new Uint8Array([42]),
    ),
    exchangeHash: await digest(bytes("portable challenge token")),
    credentialHash: await digest(
      registrationCredentialFrame(passkeyCredential),
    ),
    keyVaultHash: "",
    label: "Laborgerät",
  };
  const passkey = {
    credential: passkeyCredential,
    binding: passkeyBinding,
    proof: await sign(
      identity.signingKey.privateKey,
      passkeyRegistrationFrame(passkeyBinding),
    ),
    deletion: await sign(
      identity.signingKey.privateKey,
      passkeyDeletionFrame(passkeyBinding, "device:17"),
    ),
  };
  const delegate = await createIdentity();
  const restoredContent = await signContentEpoch(
    {
      format: "zt-content-epoch-v1",
      tenant: "laboratory:alpha",
      authorityGeneration: "1",
      number: "1",
      previous: null,
      sourceNumber: "0",
      sourceHead: null,
      snapshot: await digest(bytes("closed ciphertext snapshot")),
      actor: "researcher:lee",
    },
    identity.signingKey.privateKey,
  );
  await contentEpochFollows(restoredContent, null, null);
  const restoreOperation = "restore-research-backup";
  const restoredReview = await signContentReview(
    restoredContent,
    restoreOperation,
    await digest(bytes("observed laboratory metadata")),
    identity.signingKey.privateKey,
  );
  const logicalContent = { collection: "research-notes", key: "note:1" };
  const restoredRecord = namespaceRecord(
    logicalContent,
    restoredContent.number,
  );
  require(
    logicalRecord(restoredRecord, restoredContent.number).key ===
      logicalContent.key,
  );
  const pinnedContent = contentPin({
    format: "zt-content-pin-v1",
    record: logicalContent,
    number: restoredContent.number,
    physical: restoredRecord,
  });
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
  const shareContext = {
    authorityGeneration: "1",
    recipient: "researcher:kai",
    author: context.author,
  };
  const objectShare = await security.objects.shareObjectKey({
    object,
    expected: context,
    wrappingKey: key,
    objectSigner: identity.signingKey.publicKey,
    share: shareContext,
    recipientKey: delegate.encryptionKey.publicKey,
    signingKey: identity.signingKey.privateKey,
  });
  const shared = await security.objects.decryptSharedObject({
    object,
    expected: context,
    objectSigner: identity.signingKey.publicKey,
    envelope: objectShare,
    share: shareContext,
    recipientKey: delegate.encryptionKey.privateKey,
    grantSigner: identity.signingKey.publicKey,
  });
  const objectShareBinding = await objectKeyRecipientBinding(
    delegation.creator,
    objectShare,
  );
  require(objectShareBinding !== (await objectKeyRecipientBinding(null, null)));
  require(
    new TextDecoder().decode(shared) ===
      JSON.stringify({ observation: "Sample remains stable" }),
  );
  const commandKey = await createResourceCommandKey();
  const commandBinding = await resourceCommandBinding(commandKey.verificationKey);
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
      commandBinding,
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
  const commandContext = {
    tenant: context.tenant,
    purpose: "finish-experiment",
  };
  const resourceCommand = await signResourceCommand(
    {
      ...commandContext,
      revision: accessState.revision,
      issuedAt: "1795046400000",
      verificationKey: commandKey.verificationKey,
    },
    await openResourceCommandSigner(commandKey),
  );
  await verifyResourceCommand(resourceCommand, {
    ...commandContext,
    binding: commandBinding,
  });
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
  const continuedAdministration =
    await security.policies.signPolicyContinuation(
      administrativePolicy,
      await contentEpochFingerprint(restoredContent),
      identity.signingKey.privateKey,
    );
  const { signature: _profileSignature, ...profileFields } = profile;
  const reissuedProfile = await security.policies.administrativeProfiles.sign(
    { ...profileFields, version: continuedAdministration.version },
    delegate.signingKey.privateKey,
  );
  const alteredAdministration = {
    ...continuedAdministration.administration!,
    profiles: [reissuedProfile],
  };
  const continuedPermissions = {
    ...checkedAdministration.permissions,
    version: continuedAdministration.version,
  };
  const reissuedAdministration = {
    ...continuedPermissions,
    administration: alteredAdministration,
    signature: await sign(
      identity.signingKey.privateKey,
      security.policies.policyFrame(
        continuedPermissions,
        undefined,
        alteredAdministration,
      ),
    ),
  };
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
  const packetDigest = await security.objects.objectPacketHash(permanent);
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
    hash: await security.objects.objectPacketHash(object),
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
    passkey,
    restoredContent,
    restoreOperation,
    restoredReview,
    restoredContentFrame: base64(contentEpochFrame(restoredContent)),
    pinnedContent,
    pinnedContentKey: await contentPinKey(logicalContent),
    credential: credentialIdentifier({
      tenant: "laboratory:alpha",
      subject: "researcher:kai",
    }),
    accountVault: await createAccountVault(
      base64(crypto.getRandomValues(new Uint8Array(64))),
      "laboratory:alpha",
      "researcher:kai",
      identity,
    ),
    inventory,
    payload: { ...payload, content: payloadText },
    signer: (await publicIdentity(identity)).signingKey,
    delegation,
    accessState,
    resourceCommand,
    object,
    objectShare,
    objectShareBinding,
    policy,
    administrativePolicy,
    continuedAdministration,
    reissuedAdministration,
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
