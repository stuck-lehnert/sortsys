import type { Client } from "@sortsys/v2-client";
import {
  base64,
  certifyIdentity,
  frame,
  identityCertificate,
  identityCertificateFrame,
  importSigningKey,
  InvalidProtectedData,
  publicIdentity,
  randomSecret,
  record,
  sign,
  signingPair,
  sized,
  verify,
  type IdentityCertificate,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "../data/addressBook";
import { required } from "../protectedResult";
import { administratorContext } from "./administration";
import {
  enrollPasswordAccount,
  trustedHistory,
  unlockedAccount,
  validateChangedPassword,
} from "./session";

type Successor = Omit<
  IdentityCertificate,
  "signature" | "previousSignature"
> & {
  previousSignature: string;
};
type SigningRequest = {
  successor: Successor;
  nonce: string;
  sealedSeed: string;
  previousProof: string;
  newProof: string;
};
type TrustHistory = Awaited<ReturnType<typeof trustedHistory>>;

function parseTransfer(text: string): unknown {
  if (text.length > 4096) throw new InvalidProtectedData();
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidProtectedData();
  }
}

function readRequest(input: unknown): SigningRequest {
  const request = record(input, [
    "successor",
    "nonce",
    "sealedSeed",
    "previousProof",
    "newProof",
  ]) as SigningRequest;
  const successor = record(request.successor, [
    "tenant",
    "generation",
    "user",
    "encryptionKey",
    "signingKey",
    "previousSignature",
  ]) as Successor;
  identityCertificateFrame(successor);
  sized(successor.previousSignature, 64);
  memberId(successor.user);
  sized(request.nonce, 12);
  sized(request.sealedSeed, 48);
  sized(request.previousProof, 64);
  sized(request.newProof, 64);
  return { ...request, successor };
}

function memberId(subject: string): string {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData();
  const id = subject.slice(5);
  addressId(id);
  return id;
}

function requestProof(
  request: Omit<SigningRequest, "previousProof" | "newProof">,
) {
  return frame("sortsys/signing-renewal-request/v1", [
    base64(identityCertificateFrame(request.successor)),
    request.nonce,
    request.sealedSeed,
  ]);
}

function seedCipher(successor: Successor, nonce: Uint8Array<ArrayBuffer>) {
  return {
    name: "AES-GCM",
    iv: nonce,
    additionalData: frame("sortsys/signing-renewal-seed/v1", [
      base64(identityCertificateFrame(successor)),
    ]),
  };
}

function ownSession(client: Client, signal: AbortSignal) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (account !== unlockedAccount() || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  live();
  return { account, live };
}

async function verifyRequest(
  request: SigningRequest,
  tenant: string,
  history: TrustHistory,
) {
  const next = request.successor;
  const current = history.identityCertificate(next.user);
  if (
    next.tenant !== tenant ||
    next.generation !== history.current.generation ||
    next.previousSignature !== current.signature ||
    next.encryptionKey !== current.encryptionKey ||
    next.signingKey === current.signingKey
  )
    throw new InvalidProtectedData();
  const message = requestProof(request);
  await Promise.all([
    importSigningKey(current.signingKey).then((key) =>
      verify(key, request.previousProof, message),
    ),
    importSigningKey(next.signingKey).then((key) =>
      verify(key, request.newProof, message),
    ),
  ]);
}

/** Only an encrypted seed crosses the handoff. The existing account data key
 * opens it after re-login, including on another device or after a reload. */
export async function createSigningRequest(
  client: Client,
  signal: AbortSignal,
) {
  const { account, live } = ownSession(client, signal);
  const [history, status] = await Promise.all([
    trustedHistory(client),
    required(
      client.query("zerotrust.status", undefined, { strategy: "network-only" }),
    ),
  ]);
  live();
  const user = account.vault.subject;
  const current = history.identityCertificate(user);
  if (
    !status.profile ||
    status.profile.owner.user === user ||
    current.signingKey !== account.vault.signingKey ||
    current.encryptionKey !== account.vault.encryptionKey
  )
    throw new InvalidProtectedData();

  const seed = randomSecret();
  try {
    const signingKey = await signingPair(seed);
    const successor: Successor = {
      tenant: account.tenant,
      generation: history.current.generation,
      user,
      ...(await publicIdentity({ ...account.identity, signingKey })),
      previousSignature: current.signature,
    };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const request = {
      successor,
      nonce: base64(nonce),
      sealedSeed: base64(
        await crypto.subtle.encrypt(
          seedCipher(successor, nonce),
          account.dataKey,
          seed,
        ),
      ),
    };
    const message = requestProof(request);
    const [previousProof, newProof] = await Promise.all([
      sign(account.identity.signingKey.privateKey, message),
      sign(signingKey.privateKey, message),
    ]);
    live();
    return JSON.stringify({ ...request, previousProof, newProof });
  } finally {
    seed.fill(0);
  }
}

export async function reviewSigningRequest(
  client: Client,
  input: string,
  signal: AbortSignal,
) {
  const request = readRequest(parseTransfer(input));
  async function verifyMember() {
    const admin = await administratorContext(client, signal);
    if (request.successor.user === admin.account.vault.subject)
      throw new InvalidProtectedData();
    await verifyRequest(request, admin.account.tenant, admin.history);
    const id = memberId(request.successor.user);
    const member = await required(
      client.query(
        "zerotrust.members.status",
        { id },
        { strategy: "network-only" },
      ),
    );
    admin.live();
    if (
      member.id !== id ||
      member.deletedMicros !== null ||
      member.archivedMicros !== null ||
      member.deactivatedMicros !== null
    )
      throw new InvalidProtectedData();
    return { admin, member };
  }
  const reviewed = await verifyMember();
  return {
    username: reviewed.member.username,
    async approve() {
      const { admin, member } = await verifyMember();
      if (
        admin.account !== reviewed.admin.account ||
        member.version !== reviewed.member.version ||
        member.username !== reviewed.member.username
      )
        throw new InvalidProtectedData();
      const certificate = await certifyIdentity(
        request.successor,
        admin.authority,
      );
      admin.live();
      return JSON.stringify({ request, certificate });
    },
  };
}

export async function signingRenewalEnrollment(
  client: Client,
  input: string,
  password: string,
  signal: AbortSignal,
) {
  const { account, live } = ownSession(client, signal);
  validateChangedPassword(password);
  const approval = record(parseTransfer(input), ["request", "certificate"]);
  const request = readRequest(approval.request);
  const certificate = identityCertificate(approval.certificate);
  const next = request.successor;
  if (
    next.user !== account.vault.subject ||
    next.encryptionKey !== account.vault.encryptionKey
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  await verifyRequest(request, account.tenant, history);
  if (
    base64(identityCertificateFrame(certificate)) !==
    base64(identityCertificateFrame(next))
  )
    throw new InvalidProtectedData();
  await verify(
    history.authority(next.generation),
    certificate.signature,
    identityCertificateFrame(next),
  );
  let seed: Uint8Array<ArrayBuffer>;
  try {
    seed = new Uint8Array(
      await crypto.subtle.decrypt(
        seedCipher(next, sized(request.nonce, 12)),
        account.dataKey,
        sized(request.sealedSeed, 48),
      ),
    );
  } catch {
    throw new InvalidProtectedData();
  }
  try {
    const identity = {
      ...account.identity,
      signingKey: await signingPair(seed),
    };
    if ((await publicIdentity(identity)).signingKey !== next.signingKey)
      throw new InvalidProtectedData();
    live();
    return {
      tenant: account.tenant,
      username: account.username,
      subject: next.user,
      password,
      identity,
      replacementCertificate: certificate,
    };
  } finally {
    seed.fill(0);
  }
}

export async function completeSigningRenewal(
  client: Client,
  approval: string,
  password: string,
  signal: AbortSignal,
) {
  const enrollment = await signingRenewalEnrollment(
    client,
    approval,
    password,
    signal,
  );
  signal.throwIfAborted();
  await enrollPasswordAccount(client, enrollment);
}
