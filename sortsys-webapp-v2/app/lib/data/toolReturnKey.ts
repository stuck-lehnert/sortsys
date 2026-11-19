import type { Client } from "@sortsys/v2-client";
import {
  createResourceCommandKey,
  base64,
  boxFrame,
  hpke,
  InvalidProtectedData,
  openBox,
  openResourceCommandSigner,
  record,
  sealBox,
  sealedBox,
  signResourceCommand,
  sized,
  TOOL_RETURN_PURPOSE,
  type SealedBox,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { publicId } from "./products";

export type ToolReturnKey = {
  verificationKey: string;
  recipient: SealedBox;
  recovery: SealedBox;
};

export function toolReturnKey(input: unknown, scope: string): ToolReturnKey {
  const value = record(input, ["verificationKey", "recipient", "recovery"]);
  const verificationKey = value.verificationKey as string;
  sized(verificationKey, 32);
  const recipient = sealedBox(value.recipient);
  const recovery = sealedBox(value.recovery);
  for (const envelope of [recipient, recovery]) {
    if (
      envelope.object !== `${scope}:return:${verificationKey}` ||
      envelope.purpose !== "resource-command-key"
    ) throw new InvalidProtectedData();
    sized(envelope.ciphertext, 48);
  }
  if (
    !recipient.recipient.startsWith("user:") ||
    recovery.recipient !== `recovery:${recipient.generation}` ||
    recovery.generation !== recipient.generation ||
    recovery.author !== recipient.author ||
    recovery.tenant !== recipient.tenant
  ) throw new InvalidProtectedData();
  return { verificationKey, recipient, recovery };
}

/** One verified directory lookup per booking command, including bulk issues. */
export async function prepareToolReturnKeys(
  client: Client,
  responsible: string | null,
  signal: AbortSignal,
  verifiedHistory?: Awaited<ReturnType<typeof trustedHistory>>,
) {
  if (responsible === null) return;
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const recipient = `user:${publicId(responsible)}`;
  const history = verifiedHistory ?? await trustedHistory(client);
  signal.throwIfAborted();
  if (unlockedAccount() !== account) throw new InvalidProtectedData();
  let identity;
  try {
    identity = history.identityCertificate(recipient);
  } catch (error) {
    // A physical issue may precede the member's first registration.
    if (error instanceof InvalidProtectedData) return;
    throw error;
  }
  const [recipientKey, recoveryKey] = await Promise.all([
    hpke.kem.deserializePublicKey(sized(identity.encryptionKey, 32)),
    hpke.kem.deserializePublicKey(sized(history.current.recoveryEncryptionKey, 32)),
  ]);
  return async (tracking: string): Promise<ToolReturnKey> => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
    const key = await createResourceCommandKey();
    const seed = sized(key.signingSeed, 32);
    const context = {
      tenant: account.tenant,
      purpose: "resource-command-key" as const,
      object: `tool-tracking:${tracking}:return:${key.verificationKey}`,
      generation: history.current.generation,
      author: account.vault.subject,
    };
    try {
      const signingKey = account.identity.signingKey.privateKey;
      const [member, recovery] = await Promise.all([
        sealBox({ ...context, recipient }, seed, recipientKey, signingKey),
        sealBox(
          { ...context, recipient: `recovery:${context.generation}` },
          seed, recoveryKey, signingKey,
        ),
      ]);
      signal.throwIfAborted();
      if (unlockedAccount() !== account) throw new InvalidProtectedData();
      return { verificationKey: key.verificationKey, recipient: member, recovery };
    } finally {
      seed.fill(0);
    }
  };
}

export async function signToolReturn(
  client: Client,
  source: ToolReturnKey,
  trackingId: string,
  revision: string,
  startedAt: Date,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const { verificationKey, recipient: box } = source;
  const history = await trustedHistory(client);
  const author = await history.proofSigner(
    box.author,
    box.generation,
    box.signature,
    boxFrame(box),
  );
  signal.throwIfAborted();
  if (unlockedAccount() !== account) throw new InvalidProtectedData();
  const seed = await openBox(box, {
    tenant: account.tenant,
    purpose: "resource-command-key",
    object: `tool-tracking:${trackingId}:return:${verificationKey}`,
    generation: box.generation,
    recipient: account.vault.subject,
    author: box.author,
  }, account.identity.encryptionKey.privateKey, author);
  try {
    const signer = await openResourceCommandSigner({
      verificationKey,
      signingSeed: base64(seed),
    });
    const command = await signResourceCommand({
      tenant: account.tenant,
      purpose: TOOL_RETURN_PURPOSE,
      revision,
      issuedAt: String(Math.max(Date.now(), startedAt.getTime())),
      verificationKey,
    }, signer);
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
    return command;
  } finally {
    seed.fill(0);
  }
}
