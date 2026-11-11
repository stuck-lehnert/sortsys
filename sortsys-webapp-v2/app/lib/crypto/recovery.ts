import type { Client } from "@sortsys/v2-client";
import { base64, createRecoveryPhrase, InvalidProtectedData, normalizeRecoveryPhrase, prepareRecovery, publicIdentity, randomSecret, recoveryIdentity, recoveryInspectFrame, recoverySource, sign, verifyAuthority } from "@sortsys/zerotrust";
import type { RecoveryPlan } from "@sortsys/zerotrust";
import { passwordWorker } from "./session";

export type RecoveryDraft = { tenant: string; oldPhrase: string; newPhrase: string; password: string; generation: string };
export class RecoveryNotStarted extends Error {
  constructor() { super("Recovery has not started"); }
}

export async function recoveryDraft(client: Client, tenant: string, phrase: string, password: string, resumed = false): Promise<RecoveryDraft> {
  const oldPhrase = normalizeRecoveryPhrase(phrase);
  if (password.length < 12 || password.length > 2000) throw new InvalidProtectedData();
  const [head, error] = await client.query("zerotrust.recovery.head", { tenant }, { strategy: "network-only" });
  if (error) throw error;
  if (!head) throw new InvalidProtectedData();
  if (head.operation) {
    if (resumed) throw new InvalidProtectedData();
    const [, failure] = await client.mutate("zerotrust.recovery.resume", { tenant, operation: head.operation });
    if (failure) throw failure;
    return recoveryDraft(client, tenant, phrase, password, true);
  }
  const identity = await recoveryIdentity(oldPhrase, tenant, head.generation);
  const pub = await publicIdentity(identity);
  const authority = await verifyAuthority(head.authority, { tenant, generation: head.generation, recoverySigningKey: pub.signingKey });
  if (authority.recoveryEncryptionKey !== pub.encryptionKey) throw new InvalidProtectedData();
  return { tenant, oldPhrase, newPhrase: createRecoveryPhrase(), password, generation: head.generation };
}

export async function recoveryPlan(client: Client, draft: RecoveryDraft): Promise<RecoveryPlan> {
  const identity = await recoveryIdentity(draft.oldPhrase, draft.tenant, draft.generation);
  const nonce = base64(randomSecret());
  const proof = await sign(identity.signingKey.privateKey, recoveryInspectFrame(draft.tenant, draft.generation, nonce));
  const [input, failure] = await client.mutate("zerotrust.recovery.inspect", { tenant: draft.tenant, generation: draft.generation, nonce, proof });
  if (failure) throw failure;
  const source = recoverySource(input);
  const worker = passwordWorker();
  try {
    const { plan } = await prepareRecovery({
      oldPhrase: draft.oldPhrase, newPhrase: draft.newPhrase, password: draft.password, source,
      registrationCrypto: {
        start: password => worker.call("registrationStart", { password }),
        finish: (password, tenant, username, state, response) => worker.call("registrationFinish", { password, tenant, username, state, response }),
      },
      register: async input => {
        const [reply, error] = await client.mutate("zerotrust.recovery.registration", input);
        if (error) throw error;
        if (!reply) throw new InvalidProtectedData();
        return reply;
      },
    });
    return plan;
  } finally { worker.close(); }
}

/** A lost response is resolved by the immutable, seed-authorized operation. */
export async function commitRecovery(client: Client, plan: RecoveryPlan): Promise<void> {
  const [, error] = await client.mutate("zerotrust.recovery.begin", plan);
  if (!error) return;
  const [head] = await client.query("zerotrust.recovery.head", { tenant: plan.transition.tenant }, { strategy: "network-only" });
  if (head?.operation === plan.transition.operation) {
    const [, resumeError] = await client.mutate("zerotrust.recovery.resume", { tenant: plan.transition.tenant, operation: plan.transition.operation });
    if (resumeError) throw resumeError;
    return;
  }
  if (head?.authority.recoverySigningKey === plan.nextSetup.authority.recoverySigningKey && head.generation === plan.nextSetup.authority.generation) return;
  if (head && !head.operation && head.generation === plan.transition.generation && head.authority.recoverySigningKey === plan.sourceAuthority.recoverySigningKey) throw new RecoveryNotStarted();
  throw error;
}
