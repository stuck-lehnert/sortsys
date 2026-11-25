import {
  base64,
  frame,
  InvalidProtectedData,
  objectPacketHash,
  sign,
  type EncryptedObject,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { isStandaloneOffer } from "./commercialAreas";
import { commercialFacetPayload, type CommercialPayload } from "./commercialData";
import { ciphertextReference } from "./ciphertextReference";
import type { OpenedObject } from "./protectedObjects";
import { publicId } from "./products";
import {
  projectCommercialCollection,
  projectCommercialDomain,
  projectCommercialRegister,
  type ProjectCommercialRegister,
} from "./projectCommercial";
import {
  financialCollection,
  financialDomain,
  financialPayload,
} from "./projectFinancialData";

export type CommercialCaseLinks = {
  standaloneOffer: boolean;
  parentCase: string | null;
  documents: { id: string; source: string | null }[];
};

function optionalId(value: unknown): string | null {
  if (value === null) return null;

  const id = publicId(value);
  addressId(id);
  return id;
}

/** Derive only the technical metadata needed to check deletion. Use the exact
 * master-data packet being published, not the documents visible to the caller
 * or the subset for which a current editor head exists. */
export function commercialCaseLinks(payload: CommercialPayload): CommercialCaseLinks {
  if (payload.facet !== "master-data") throw new InvalidProtectedData();

  const main = payload.rows.filter((row) => row.table === "commercial_cases");
  if (main.length !== 1 || optionalId(main[0]!.values.id) !== payload.caseId) {
    throw new InvalidProtectedData();
  }

  const { kind, project_id: project, parent_case_id: parent } = main[0]!.values;
  const projectId = optionalId(project);
  const documents = payload.rows.flatMap(({ table, values }) => {
    if (table !== "commercial_documents") return [];

    const id = optionalId(values.id);
    if (!id || optionalId(values.case_id) !== payload.caseId) {
      throw new InvalidProtectedData();
    }

    return [{ id, source: optionalId(values.source_document_id) }];
  });
  documents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (documents.some(({ id }, index) => index > 0 && documents[index - 1]!.id === id)) {
    throw new InvalidProtectedData();
  }

  return {
    standaloneOffer: isStandaloneOffer(kind, projectId),
    parentCase: optionalId(parent),
    documents,
  };
}

export function commercialLinksFrame(hash: string, links: CommercialCaseLinks) {
  return frame("sortsys/commercial-case-links/v1", [
    hash,
    links.standaloneOffer ? "1" : "0",
    links.parentCase ?? "",
    ...links.documents.flatMap(({ id, source }) => [id, source ?? ""]),
  ]);
}

function projectCaseIds(register: ProjectCommercialRegister): string[] {
  const cases = new Set<string>();
  if (register.mainCaseId !== null) cases.add(register.mainCaseId);

  for (const { row } of register.offers) {
    const id = optionalId(row.values.commercial_case_id);
    if (id !== null) cases.add(id);
  }

  for (const { caseId, parentCaseId } of register.awards) {
    cases.add(caseId);
    if (parentCaseId !== null) cases.add(parentCaseId);
  }

  return [...cases].sort();
}

async function commercialLinksStatement(
  envelope: EncryptedObject,
  value: unknown,
) {
  const { scope, facet, object } = envelope;
  if (scope.startsWith("commercial:") && facet === "master-data" && object === `${scope}:${facet}:case`) {
    const caseId = scope.slice("commercial:".length);
    const links = commercialCaseLinks(commercialFacetPayload(value, caseId, "master-data"));
    const hash = await objectPacketHash(envelope);
    return { links, message: commercialLinksFrame(hash, links) };
  }

  const domain = `${scope}:${facet}`;
  const workflow = projectCommercialDomain(domain);
  if (
    workflow &&
    object === `${projectCommercialCollection(workflow.id, workflow.facet).prefix}register`
  ) {
    const register = projectCommercialRegister(value, workflow.id, workflow.facet);
    const projectCases = projectCaseIds(register);
    const hash = await objectPacketHash(envelope);
    return {
      links: { projectCases },
      message: projectRegisterLinksFrame(hash, projectCases),
    };
  }

  const financial = financialDomain(domain);
  if (!financial) return undefined;

  const { projectId, type } = financial;
  let area = financialCollection(projectId, type);
  if (!object.startsWith(area.prefix)) {
    if (type !== "invoice") return undefined;

    area = financialCollection(projectId, type, true);
    if (!object.startsWith(area.prefix)) return undefined;
  }

  // Entry IDs are independent of the optional case reference in the payload.
  const { row } = financialPayload(value, object, area);
  const financialCase = optionalId(row.values.commercial_case_id);
  const hash = await objectPacketHash(envelope);
  return {
    links: { financialCase },
    message: financialLinkFrame(hash, financialCase),
  };
}

export async function commercialLinksPacket(
  envelope: EncryptedObject,
  value: unknown,
  signingKey: CryptoKey,
) {
  const statement = await commercialLinksStatement(envelope, value);
  if (!statement) return undefined;

  const signature = await sign(signingKey, statement.message);
  return { ...statement.links, signature };
}

/** Attest to an already verified, decrypted object without replacing its
 * encrypted revision. Only the unlocked tenant authority can review it. */
export async function reviewCommercialLinks(
  { envelope, value }: OpenedObject,
  authority: CryptoKey,
) {
  const statement = await commercialLinksStatement(envelope, value);
  if (!statement) return undefined;

  const { tenant, scope, facet, object } = envelope;
  const domain = `${scope}:${facet}`;
  const reference = await ciphertextReference(envelope);
  const review = frame("sortsys/commercial-legacy-binding/v1", [
    tenant,
    domain,
    object,
    reference,
    base64(statement.message),
  ]);
  const signature = await sign(authority, review);

  return { domain, object, reference, links: { ...statement.links, signature } };
}

export function financialLinkFrame(hash: string, financialCase: string | null) {
  return frame("sortsys/financial-case-link/v1", [hash, financialCase ?? ""]);
}

export function projectRegisterLinksFrame(hash: string, cases: readonly string[]) {
  return frame("sortsys/project-register-case-links/v1", [hash, ...cases]);
}
