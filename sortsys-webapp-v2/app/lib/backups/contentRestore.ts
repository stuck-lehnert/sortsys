import type { Client, MutateInput, MutateResult } from "@sortsys/v2-client";
import {
  authorityFrame,
  base64,
  contentEpochFingerprint,
  contentEpochFollows,
  InvalidProtectedData,
  signContentEpoch,
  signPolicyContinuation,
  verifyContentEpoch,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import { readVerifiedPolicy } from "../crypto/policy";

/** Bind the prepared copy to the current account's pinned authority and policy.
 * The called workflow owns the confirmation and sends the resulting approval. */
export async function approvePreparedContent(
  client: Client,
  prepared: MutateResult<"zerotrust.content.prepare">,
  signal: AbortSignal,
): Promise<MutateInput<"zerotrust.content.activate">> {
  const context = await administratorContext(client, signal);
  const { account, history, authority } = context;
  const expected = { tenant: account.tenant };
  const sourceAuthority = history.authorityCertificate(
    prepared.sourceAuthority.generation,
  );
  if (
    sourceAuthority.signature !== prepared.sourceAuthority.signature ||
    base64(authorityFrame(sourceAuthority)) !==
      base64(authorityFrame(prepared.sourceAuthority))
  )
    throw new InvalidProtectedData();
  const [previous, source, previousPolicy] = await Promise.all([
    prepared.current &&
      verifyContentEpoch(prepared.current, expected, history.authority),
    prepared.source &&
      verifyContentEpoch(prepared.source, expected, history.authority),
    readVerifiedPolicy(client, context),
  ]);
  context.live();
  const approval = await signContentEpoch(
    {
      format: "zt-content-epoch-v1",
      tenant: account.tenant,
      authorityGeneration: history.current.generation,
      number: prepared.number,
      previous: previous ? await contentEpochFingerprint(previous) : null,
      sourceNumber: source?.number ?? "0",
      sourceHead: source ? await contentEpochFingerprint(source) : null,
      snapshot: prepared.snapshot,
      actor: `user:${context.session.user.id}`,
    },
    authority,
  );
  await contentEpochFollows(approval, previous, source);
  const { permissions, ...evidence } = previousPolicy;
  const policy = await signPolicyContinuation(
    { ...permissions, ...evidence },
    await contentEpochFingerprint(approval),
    authority,
  );
  context.live();
  return { operation: prepared.operation, approval, policy };
}
