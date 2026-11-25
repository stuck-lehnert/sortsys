import type { Client } from "@sortsys/v2-client";
import {
  compilePolicy,
  frame,
  InvalidProtectedData,
  sign,
} from "@sortsys/zerotrust/sortsys";
import { patchAccessRules } from "../crypto/accessProfiles";
import { administratorContext } from "../crypto/administration";
import { publishVerifiedPolicy } from "../crypto/policy";
import {
  commercialCollection,
  commercialMasterArea,
  COMMERCIAL_FACETS,
  type CommercialFacet,
} from "./commercialAreas";
import { commercialCaseLinks } from "./commercialCaseLinks";
import { commercialFacetPayload } from "./commercialData";
import { ciphertextReference } from "./ciphertextReference";
import { protectedLivePacket, required } from "./protectedObjects";

export function mayRetireOffer(
  scope: string,
  allows: (scope: string, facet: CommercialFacet, action: "delete") => boolean,
): boolean {
  return COMMERCIAL_FACETS.every((facet) => allows(scope, facet, "delete"));
}

async function liveOffer(
  client: Client,
  caseId: string,
  signal: AbortSignal,
) {
  const area = commercialMasterArea(caseId);
  const snapshot = await protectedLivePacket(client, area, signal);
  snapshot.live();

  const payload = commercialFacetPayload(snapshot.object.value, caseId, "master-data");
  if (!commercialCaseLinks(payload).standaloneOffer)
    throw new InvalidProtectedData();

  const title = payload.rows.find(({ table }) => table === "commercial_cases")
    ?.values.title;
  if (typeof title !== "string") throw new InvalidProtectedData();

  return { snapshot, area, title };
}

/** The authority holder explicitly decides only their own delete permissions
 * on this offer. No origin grant, administrator role or key rotation is used
 * as a substitute for the signed policy decision. */
export async function setOwnOfferRetirement(
  client: Client,
  caseId: string,
  allowed: boolean,
  signal: AbortSignal,
) {
  const [{ snapshot, area }, context] = await Promise.all([
    liveOffer(client, caseId, signal),
    administratorContext(client, signal),
  ]);
  snapshot.live();
  context.live();

  if (
    snapshot.account !== context.account ||
    snapshot.subject !== `user:${context.session.user.id}` ||
    snapshot.authorityGeneration !== context.history.current.generation
  )
    throw new InvalidProtectedData();

  const rules = patchAccessRules(
    snapshot.policy.rules,
    snapshot.subject,
    COMMERCIAL_FACETS.map((facet) => ({
      area: commercialCollection(caseId, facet),
      patch: { delete: allowed },
    })),
  );
  const next = { ...snapshot.policy, rules };
  const access = compilePolicy(next, [snapshot.subject]);
  if (mayRetireOffer(area.scope, access.allows) !== allowed)
    throw new InvalidProtectedData();

  if (JSON.stringify(rules) === JSON.stringify(snapshot.policy.rules)) return;

  await publishVerifiedPolicy(client, context, {
    ...next,
    version: (BigInt(next.version) + 1n).toString(),
  });
}

/** Derive the confirmation title and signed command from the same packet.
 * The server independently checks current permissions and relationship
 * coverage in the same transaction as the removal. */
export async function prepareOfferRetirement(
  client: Client,
  caseId: string,
  signal: AbortSignal,
) {
  const { snapshot, area, title } = await liveOffer(client, caseId, signal);
  snapshot.live();

  // Grants inherited from a creation origin are insufficient for retirement.
  const access = compilePolicy(snapshot.policy, [snapshot.subject]);
  if (!mayRetireOffer(area.scope, access.allows))
    throw new InvalidProtectedData();

  const command = {
    tenant: snapshot.account.tenant,
    author: snapshot.subject,
    authorityGeneration: snapshot.authorityGeneration,
    policyVersion: snapshot.policy.version,
    contentEpoch: snapshot.contentEpoch,
    caseId,
    expectedReference: await ciphertextReference(snapshot.object.envelope),
  };
  snapshot.live();

  const signature = await sign(
    snapshot.account.identity.signingKey.privateKey,
    frame("sortsys/commercial-retirement/v1", [
      command.tenant,
      command.author,
      command.authorityGeneration,
      command.policyVersion,
      command.contentEpoch,
      command.caseId,
      command.expectedReference,
    ]),
  );
  snapshot.live();

  return { title, command: { ...command, signature }, live: snapshot.live };
}

export type PreparedOfferRetirement = Awaited<ReturnType<typeof prepareOfferRetirement>>;

export async function submitOfferRetirement(client: Client, proposal: PreparedOfferRetirement) {
  proposal.live();
  const result = await required(
    client.mutate("zerotrust.commercial.removeOffer", proposal.command),
  );
  proposal.live();
  return result;
}
