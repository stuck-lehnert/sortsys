import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  createRecoveryPhrase,
  InvalidProtectedData,
  normalizeRecoveryPhrase,
  prepareRecovery,
  publicIdentity,
  randomSecret,
  recoveryIdentity,
  recoveryInspectFrame,
  recoveryPageFrame,
  loadRecoverySource,
  sign,
  verifyAuthority,
  boxFrame,
  digest,
  signedPacketFrame,
  recoveryCatalogAccessFrame,
  sealedBox,
  preparePayload,
  recoveryAccountFrame,
  recoveryMemberFrame,
  existingRecoveryAccount,
} from "@sortsys/zerotrust/sortsys";
import type {
  RecoveryPlan,
  RecoveryCatalogStorage,
  SealedBox,
  ExistingRecoveryAccount,
} from "@sortsys/zerotrust/sortsys";
import { passwordWorker } from "./session";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import { required } from "../protectedResult";

export type RecoveryDraft = {
  tenant: string;
  oldPhrase: string;
  newPhrase: string;
  password: string;
  generation: string;
  administrator?: ExistingRecoveryAccount;
  member?: { account: ExistingRecoveryAccount; password: string };
};
export class RecoveryAccountUnavailable extends Error {
  constructor() {
    super("The existing recovery administrator is unavailable");
  }
}
export class RecoveryMemberUnavailable extends Error {
  constructor() {
    super("The selected recovery member is unavailable");
  }
}
export class RecoveryNotStarted extends Error {
  constructor() {
    super("Recovery has not started");
  }
}

export async function recoveryDraft(
  client: Client,
  tenant: string,
  phrase: string,
  password: string,
  options: {
    restoreAdministrator?: boolean;
    member?: { username: string; password: string };
  } = {},
  resumed = false,
): Promise<RecoveryDraft> {
  const oldPhrase = normalizeRecoveryPhrase(phrase);
  if (password.length < 12 || password.length > 2000)
    throw new InvalidProtectedData();
  const [head, error] = await client.query(
    "zerotrust.recovery.head",
    { tenant },
    { strategy: "network-only" },
  );
  if (error) throw error;
  if (!head) throw new InvalidProtectedData();
  if (head.operation) {
    if (resumed) throw new InvalidProtectedData();
    const [, failure] = await client.mutate("zerotrust.recovery.resume", {
      tenant,
      operation: head.operation,
    });
    if (failure) throw failure;
    return recoveryDraft(client, tenant, phrase, password, options, true);
  }
  const identity = await recoveryIdentity(oldPhrase, tenant, head.generation);
  const pub = await publicIdentity(identity);
  const authority = await verifyAuthority(head.authority, {
    tenant,
    generation: head.generation,
    recoverySigningKey: pub.signingKey,
  });
  if (authority.recoveryEncryptionKey !== pub.encryptionKey)
    throw new InvalidProtectedData();
  const administrator = options.restoreAdministrator
    ? await currentRecoveryAdministrator(
        client,
        tenant,
        head.generation,
        identity.signingKey.privateKey,
      )
    : undefined;
  const member = options.member;
  if (
    member &&
    (member.password.length < 12 || member.password.length > 2000)
  ) {
    throw new InvalidProtectedData();
  }
  const recoveredMember = member
    ? {
        account: await currentRecoveryMember(
          client,
          tenant,
          head.generation,
          member.username.trim().toLowerCase(),
          identity.signingKey.privateKey,
        ),
        password: member.password,
      }
    : undefined;
  return {
    tenant,
    oldPhrase,
    newPhrase: createRecoveryPhrase(),
    password,
    generation: head.generation,
    ...(administrator ? { administrator } : {}),
    ...(recoveredMember ? { member: recoveredMember } : {}),
  };
}

async function currentRecoveryAdministrator(
  client: Client,
  tenant: string,
  generation: string,
  key: CryptoKey,
): Promise<ExistingRecoveryAccount> {
  const nonce = base64(randomSecret());
  const [reply, error] = await client.mutate("zerotrust.recovery.account", {
    tenant,
    generation,
    nonce,
    proof: await sign(key, recoveryAccountFrame(tenant, generation, nonce)),
  });
  if (error) throw error;
  if (!reply) throw new RecoveryAccountUnavailable();
  return existingRecoveryAccount(reply);
}

async function currentRecoveryMember(
  client: Client,
  tenant: string,
  generation: string,
  username: string,
  key: CryptoKey,
): Promise<ExistingRecoveryAccount> {
  const nonce = base64(randomSecret());
  const [reply, error] = await client.mutate("zerotrust.recovery.member", {
    tenant,
    generation,
    username,
    nonce,
    proof: await sign(
      key,
      recoveryMemberFrame(tenant, generation, username, nonce),
    ),
  });
  if (error) throw error;
  if (!reply) throw new RecoveryMemberUnavailable();
  const account = existingRecoveryAccount(reply);
  if (account.username !== username) throw new InvalidProtectedData();
  return account;
}

export async function recoveryPlan(
  client: Client,
  draft: RecoveryDraft,
): Promise<RecoveryPlan> {
  const identity = await recoveryIdentity(
    draft.oldPhrase,
    draft.tenant,
    draft.generation,
  );
  // Refresh the account fingerprint on retry. The API checks it again during
  // registration and publication; a concurrent password change is never lost.
  const administrator = draft.administrator
    ? await currentRecoveryAdministrator(
        client,
        draft.tenant,
        draft.generation,
        identity.signingKey.privateKey,
      )
    : undefined;
  if (administrator && administrator.subject !== draft.administrator?.subject)
    throw new InvalidProtectedData();
  const member = draft.member
    ? {
        account: await currentRecoveryMember(
          client,
          draft.tenant,
          draft.generation,
          draft.member.account.username,
          identity.signingKey.privateKey,
        ),
        password: draft.member.password,
      }
    : undefined;
  if (member && member.account.subject !== draft.member?.account.subject) {
    throw new InvalidProtectedData();
  }
  const nonce = base64(randomSecret());
  const proof = await sign(
    identity.signingKey.privateKey,
    recoveryInspectFrame(draft.tenant, draft.generation, nonce),
  );
  const [input, failure] = await client.mutate("zerotrust.recovery.inspect", {
    tenant: draft.tenant,
    generation: draft.generation,
    nonce,
    proof,
  });
  if (failure) throw failure;
  const source = await loadRecoverySource({
    head: input,
    read: async (request, head) => {
      if (
        head.authority.tenant !== draft.tenant ||
        head.authority.generation !== draft.generation
      ) {
        throw new InvalidProtectedData();
      }
      const access = {
        tenant: draft.tenant,
        generation: draft.generation,
        challengeId: head.challengeId,
        challenge: head.challenge,
        snapshot: head.snapshot,
        after: request.after,
      };
      const pageProof = await sign(
        identity.signingKey.privateKey,
        recoveryPageFrame(access),
      );
      const [page, error] = await client.mutate("zerotrust.recovery.page", {
        tenant: access.tenant,
        generation: access.generation,
        challengeId: access.challengeId,
        snapshot: access.snapshot,
        after: access.after,
        proof: pageProof,
      });
      if (error) throw error;
      if (!page) throw new InvalidProtectedData();
      return page;
    },
  });
  const catalogStorage: RecoveryCatalogStorage = {
    async read(reference: {
      object: string;
      hash: string;
      generation: string;
    }) {
      const access = {
        tenant: draft.tenant,
        generation: draft.generation,
        challengeId: source.challengeId,
        challenge: source.challenge,
        targetGeneration: reference.generation,
        object: reference.object,
        hash: reference.hash,
        action: "read" as const,
      };
      const proof = await sign(
        identity.signingKey.privateKey,
        recoveryCatalogAccessFrame(access),
      );
      const [packet, error] = await client.mutate(
        "zerotrust.recovery.catalog.read",
        { access, proof },
      );
      if (error) throw error;
      if (!packet) throw new InvalidProtectedData();
      return sealedBox(packet);
    },
    async write(packet: SealedBox) {
      const access = {
        tenant: draft.tenant,
        generation: draft.generation,
        challengeId: source.challengeId,
        challenge: source.challenge,
        targetGeneration: packet.generation,
        object: packet.object,
        hash: await digest(
          signedPacketFrame(boxFrame(packet), packet.signature),
        ),
        action: "write" as const,
      };
      const proof = await sign(
        identity.signingKey.privateKey,
        recoveryCatalogAccessFrame(access),
      );
      const [, error] = await client.mutate(
        "zerotrust.recovery.catalog.write",
        { access, proof, packet },
      );
      if (error) {
        // A successful write can lose its reply. The catalog builder still
        // requires byte-exact readback before publishing the new root.
        const saved = await catalogStorage.read({
          object: packet.object,
          hash: access.hash,
          generation: packet.generation,
        });
        if (
          (await digest(
            signedPacketFrame(boxFrame(saved), saved.signature),
          )) !== access.hash
        )
          throw error;
      }
    },
  };
  const worker = passwordWorker();
  try {
    const { plan } = await prepareRecovery({
      oldPhrase: draft.oldPhrase,
      newPhrase: draft.newPhrase,
      password: draft.password,
      source,
      ...(administrator ? { administrator } : {}),
      ...(member ? { members: [member] } : {}),
      catalogStorage,
      registrationCrypto: {
        start: (password) => worker.call("registrationStart", { password }),
        finish: (password, tenant, subject, state, response) =>
          worker.call("registrationFinish", {
            password,
            tenant,
            subject,
            state,
            response,
          }),
      },
      register: async (input) => {
        const [reply, error] = await client.mutate(
          "zerotrust.recovery.registration",
          input,
        );
        if (error) throw error;
        if (!reply) throw new InvalidProtectedData();
        return reply;
      },
    });
    return plan;
  } finally {
    worker.close();
  }
}

async function isActivatedRecovery(
  head: QueryResult<"zerotrust.recovery.head">,
  plan: RecoveryPlan,
): Promise<boolean> {
  let expected = plan.sourceAuthority;
  let activated = false;
  if (head.generation === plan.nextSetup.authority.generation) {
    expected = plan.nextSetup.authority;
    activated = true;
  } else if (head.generation !== plan.transition.generation) {
    throw new InvalidProtectedData();
  }
  const authority = await verifyAuthority(head.authority, {
    tenant: plan.transition.tenant,
    generation: expected.generation,
    recoverySigningKey: expected.recoverySigningKey,
  });
  if (authority.signature !== expected.signature)
    throw new InvalidProtectedData();
  return activated;
}

/** Staging is invisible. The activated authority is always verified again,
 * including after a positive acknowledgement or a lost publication response. */
export async function commitRecovery(
  client: Client,
  plan: RecoveryPlan,
): Promise<void> {
  const before = await required(
    client.query(
      "zerotrust.recovery.head",
      {
        tenant: plan.transition.tenant,
      },
      { strategy: "network-only" },
    ),
  );
  if (await isActivatedRecovery(before, plan)) return;
  let failure: unknown;
  try {
    const { manifest, parts } = preparePayload(JSON.stringify(plan), {
      context: plan.transition.tenant,
      operation: plan.transition.operation,
    });
    const authorization = {
      challengeId: plan.challengeId,
      sourceAuthority: plan.sourceAuthority,
      transition: plan.transition,
      proof: plan.proof,
    };
    await mapConcurrent(parts, 4, async (content, index) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const receipt = await required(
            client.mutate("zerotrust.recovery.stage", {
              authorization,
              manifest,
              content,
            }),
          );
          if (receipt.hash !== manifest.parts[index])
            throw new InvalidProtectedData();
          return;
        } catch (error) {
          if (error instanceof InvalidProtectedData || attempt >= 1)
            throw error;
        }
      }
    });
    const result = await required(
      client.mutate("zerotrust.recovery.commit", { authorization, manifest }),
    );
    if (result.success !== true) throw new InvalidProtectedData();
  } catch (error) {
    failure = error;
  }
  const [head] = await client.query(
    "zerotrust.recovery.head",
    { tenant: plan.transition.tenant },
    { strategy: "network-only" },
  );
  if (head) {
    if (await isActivatedRecovery(head, plan)) return;
    throw new RecoveryNotStarted();
  }
  throw failure ?? new InvalidProtectedData();
}
