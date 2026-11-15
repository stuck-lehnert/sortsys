import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  documentHead,
  documentHeadFrame,
  documentTimestampTarget,
  encryptedObject,
  evaluateOtsProof,
  importSigningKey,
  InvalidProtectedData,
  mergeOtsNodes,
  objectFrame,
  objectTimestampTarget,
  parseOtsProof,
  serializeOtsProof,
  signedPacketFrame,
  sized,
  stampOtsDigest,
  timestampTarget,
  unbase64,
  upgradeOtsProof,
  verifyDomain,
  type OtsNode,
  type TimestampTarget,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "./session";
import { createObjectAuthorVerifier } from "./objectAuthors";
import { required } from "../data/protectedObjects";
import { listenDataChanges } from "../data/runtime/changes";

type Evidence = NonNullable<QueryResult<"zerotrust.timestamps.get">>;
type ExpectedTarget = Pick<TimestampTarget, "scope" | "object" | "revision">;
/** Validate an API's target against the actual signed ciphertext and the pinned
 * authority history, bound to the requested revision. A valid proof for another
 * record must never be shown under the requested record's title. */
export async function checkTimestampEvidence(
  client: Client,
  value: Evidence,
  expected: ExpectedTarget,
  signal: AbortSignal,
): Promise<{
  target: TimestampTarget;
  packet: Uint8Array<ArrayBuffer>;
  proof: Uint8Array<ArrayBuffer> | null;
}> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (!client.loggedIn() || account !== unlockedAccount())
      throw new InvalidProtectedData();
  };
  live();
  const target = timestampTarget(value.target);
  if (
    target.tenant !== account.tenant ||
    target.scope !== expected.scope ||
    target.object !== expected.object ||
    target.revision !== expected.revision ||
    !Array.isArray(value.proofs) ||
    value.proofs.length > 32
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  live();
  let actual: TimestampTarget | null;
  let packet: Uint8Array<ArrayBuffer>;
  if (target.kind === "document") {
    const head = documentHead(value.artifact);
    const signer = await importSigningKey(
      history.identityCertificate(head.author, head.generation).signingKey,
    );
    actual = await documentTimestampTarget(head, signer);
    packet = signedPacketFrame(await documentHeadFrame(head), head.signature);
  } else {
    const envelope = encryptedObject(value.artifact);
    const id = `${envelope.scope}:${envelope.facet}`;
    const raw = await required(
      client.query(
        "zerotrust.domains.get",
        { domain: id, generation: envelope.generation },
        { strategy: "network-only" },
      ),
    );
    live();
    const definition = await verifyDomain(
      raw,
      {
        tenant: account.tenant,
        id,
        scope: envelope.scope,
        facet: envelope.facet,
        generation: envelope.generation,
      },
      history.authority,
    );
    const signer = await createObjectAuthorVerifier(client, {
      account,
      history,
      live,
    })(envelope, definition);
    actual = await objectTimestampTarget(envelope, signer);
    packet = signedPacketFrame(objectFrame(envelope), envelope.signature);
  }
  if (
    !actual ||
    Object.keys(actual).some(
      (key) =>
        actual![key as keyof TimestampTarget] !==
        target[key as keyof TimestampTarget],
    )
  )
    throw new InvalidProtectedData();
  let node: OtsNode | null = null;
  for (const input of value.proofs) {
    const next = parseOtsProof(
      unbase64(input, 256 * 1024),
      sized(target.digest, 32),
    );
    node = node ? mergeOtsNodes(node, next.node) : next.node;
  }
  const data = node
    ? serializeOtsProof({ hash: 8, digest: sized(target.digest, 32), node })
    : null;
  if (data) await evaluateOtsProof(data, sized(target.digest, 32), signal);
  live();
  return { target, packet, proof: data };
}

export type TimestampAttempt = "submitted" | "empty" | "deferred";

/** Only explicit production mounting enables calendar traffic. Distinguish an
 * empty queue from unavailable evidence so only an outage backs off new hints.
 * Failed or cancelled attempts never change source data or existing proofs. */
export async function timestampEvidenceAttempt(
  client: Client,
  signal: AbortSignal,
  options: {
    stamp?: typeof stampOtsDigest;
    upgrade?: typeof upgradeOtsProof;
  } = {},
): Promise<TimestampAttempt> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (!client.loggedIn() || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  live();
  const [work, error] = await client.mutate(
    "zerotrust.timestamps.work",
    undefined,
    { signal },
  );
  live();
  if (error) throw error;
  if (!work) return "empty";
  let proof: string | null = null;
  let previousProof: string | null = null;
  try {
    const checked = await checkTimestampEvidence(
      client,
      work.evidence,
      work.evidence.target,
      signal,
    );
    live();
    const digest = sized(checked.target.digest, 32);
    let bytes = checked.proof;
    if (bytes) previousProof = base64(bytes);
    if (bytes)
      bytes = await (options.upgrade ?? upgradeOtsProof)(bytes, digest, {
        signal,
      });
    else bytes = await (options.stamp ?? stampOtsDigest)(digest, { signal });
    // Network adapters are not allowed to change the committed root.
    await evaluateOtsProof(bytes, digest, signal);
    live();
    proof = base64(bytes);
  } catch {
    live(); /* Null is retry-only; source records and prior proofs survive. */
  }
  live();
  const [, failure] = await client.mutate(
    "zerotrust.timestamps.finish",
    { digest: work.evidence.target.digest, lease: work.lease, proof },
    { signal },
  );
  live();
  if (failure) throw failure;
  if (proof === null || proof === previousProof) return "deferred";
  return "submitted";
}

/** One bounded sequential runner per mounted account. Existing document events
 * wake it up; idle retry checks are at most every 15 minutes, never per edit. */
export function startTimestampEvidence(
  client: Client,
  signal: AbortSignal,
  options: {
    attempt?: typeof timestampEvidenceAttempt;
    intervalMs?: number;
  } = {},
): () => void {
  const account = unlockedAccount();
  let stopped = false;
  let running = false;
  let requested = false;
  let retryNotBefore = 0;
  const retryInterval = options.intervalMs ?? 15 * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () =>
    !stopped &&
    !signal.aborted &&
    account !== null &&
    account === unlockedAccount() &&
    client.loggedIn();
  function schedule(delay: number) {
    if (!active()) return;
    if (running) {
      requested = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(wake, Math.max(delay, retryNotBefore - Date.now()));
  }
  function wake() {
    if (!active()) return;
    if (running) {
      requested = true;
      return;
    }
    clearTimeout(timer);
    running = true;
    requested = false;
    void (async () => {
      // Avoid monopolizing the network when an account sees many old records.
      for (let index = 0; index < 8 && active(); index++) {
        const result = await (options.attempt ?? timestampEvidenceAttempt)(
          client,
          signal,
        );
        if (result === "deferred") {
          retryNotBefore = Date.now() + retryInterval;
          return;
        }
        if (result === "empty") return;
      }
      requested = true;
    })()
      .catch(() => {
        retryNotBefore = Date.now() + retryInterval;
      })
      .finally(() => {
        running = false;
        if (active()) schedule(requested ? 1000 : retryInterval);
      });
  }
  const stopChanges = listenDataChanges(client, (domains) => {
    if (
      !domains ||
      [...domains].some(
        (id) =>
          id.startsWith("absence:") ||
          id.startsWith("commercial:") ||
          id.endsWith(":billing"),
      )
    )
      schedule(1000);
  });
  function stop() {
    stopped = true;
    clearTimeout(timer);
    stopChanges();
    signal.removeEventListener("abort", stop);
  }
  signal.addEventListener("abort", stop, { once: true });
  schedule(0);
  return stop;
}
