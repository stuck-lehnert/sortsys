import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  signedPacketFrame,
} from "./encoding";
import { importSigningKey, sign } from "./identity";
import {
  publicProofDigest as digest,
  verifyPublicProof as verify,
} from "./publicProofs";
import {
  createDelegationCodec,
  type DelegationCertificate,
} from "./core/delegations";
import type { Rule } from "./policy";
import type { Facet } from "./objects";

export const PROJECT_CREATION_SCOPE = "create:project";
export type CreationNamespace = keyof typeof CREATION_FACETS;
export const CREATION_FACETS = {
  project: [
    "master-data",
    "attachment",
    "offer-prices",
    "procurement",
    "billing",
  ],
  commercial: [
    "master-data",
    "scope",
    "contract-quantities",
    "measurement",
    "offer-prices",
    "calculation",
    "procurement",
    "billing",
    "attachment",
  ],
  tool: ["master-data", "procurement", "measurement"],
  "tool-tracking": ["master-data", "procurement", "scope"],
} as const;
export const PROJECT_MODULE_FACETS = {
  "delivery-notes": ["master-data", "procurement"],
  "daily-reports": ["master-data", "calculation"],
  "regie-reports": ["master-data", "personnel"],
  planning: ["master-data"],
  "tool-usage": ["master-data", "procurement"],
} as const;
export type ProjectModule = keyof typeof PROJECT_MODULE_FACETS;
export function creationScope(namespace: CreationNamespace): string {
  if (!Object.hasOwn(CREATION_FACETS, namespace))
    throw new InvalidProtectedData();
  return `create:${namespace}`;
}
export function creationResource(
  scope: unknown,
): { namespace: CreationNamespace; id: string; module?: ProjectModule } | null {
  if (typeof scope !== "string") return null;
  const parts = scope.split(":"),
    namespace = parts[0],
    token = parts[1];
  if (
    ![2, 3].includes(parts.length) ||
    !namespace ||
    !Object.hasOwn(CREATION_FACETS, namespace) ||
    !token ||
    !/^[1-9a-v][0-9a-v]{0,12}$/.test(token)
  )
    return null;
  const module = parts[2];
  if (
    parts.length === 3 &&
    (namespace !== "project" ||
      !module ||
      !Object.hasOwn(PROJECT_MODULE_FACETS, module))
  )
    return null;
  let id = 0n;
  for (const character of token)
    id = id * 32n + BigInt(parseInt(character, 32));
  return id > 9223372036854775807n
    ? null
    : {
        namespace: namespace as CreationNamespace,
        id: token,
        ...(module ? { module: module as ProjectModule } : {}),
      };
}
export function creationFacets(scope: unknown): readonly Facet[] {
  const resource = creationResource(scope);
  if (!resource) throw new InvalidProtectedData();
  return resource.module
    ? PROJECT_MODULE_FACETS[resource.module]
    : CREATION_FACETS[resource.namespace];
}
export type CreationCapability = DelegationCertificate<CreationNamespace>;
export type CreationParent = {
  tenant: string;
  id: string;
  scope: string;
  facet: Facet;
  capability: CreationCapability;
  signature: string;
};
export type CreationOrigin = CreationParent & { parent?: CreationParent };

const delegations = createDelegationCodec(
  Object.keys(CREATION_FACETS) as CreationNamespace[],
);
export const creationCapability = delegations.parse;
export const creationCapabilityFrame = delegations.frame;
export const certifyCreationCapability = delegations.certify;
export async function verifyCreationCapability(
  input: unknown,
  authority: CryptoKey,
): Promise<CreationCapability> {
  const value = creationCapability(input);
  return delegations.verify(
    value,
    {
      tenant: value.tenant,
      generation: value.generation,
      namespace: value.namespace,
      creator: value.creator.user,
    },
    authority,
  );
}
export function creationOrigin(input: unknown): CreationOrigin {
  const hasParent =
    !!input && typeof input === "object" && Object.hasOwn(input, "parent");
  const value = record(input, [
    "tenant",
    "id",
    "scope",
    "facet",
    "capability",
    "signature",
    ...(hasParent ? ["parent"] : []),
  ]);
  const capability = creationCapability(value.capability);
  if (
    value.tenant !== capability.tenant ||
    typeof value.scope !== "string" ||
    typeof value.signature !== "string"
  )
    throw new InvalidProtectedData();
  const resource = creationResource(value.scope);
  if (
    !resource ||
    resource.namespace !== capability.namespace ||
    !creationFacets(value.scope).includes(value.facet as Facet) ||
    value.id !== `${value.scope}:${value.facet}` ||
    !!resource.module !== hasParent
  )
    throw new InvalidProtectedData();
  let parent: CreationParent | undefined;
  if (resource.module) {
    // The parent is exactly one project root. Reject nesting before recursing.
    const raw = record(value.parent, [
      "tenant",
      "id",
      "scope",
      "facet",
      "capability",
      "signature",
    ]);
    if (
      raw.scope !== `project:${resource.id}` ||
      raw.id !== `${raw.scope}:master-data` ||
      raw.facet !== "master-data"
    )
      throw new InvalidProtectedData();
    parent = creationOrigin(raw);
    const first = parent.capability.creator,
      next = capability.creator;
    if (
      parent.tenant !== capability.tenant ||
      parent.capability.generation !== capability.generation ||
      first.user !== next.user ||
      first.signingKey !== next.signingKey ||
      first.encryptionKey !== next.encryptionKey
    )
      throw new InvalidProtectedData();
  }
  return {
    tenant: capability.tenant,
    id: value.id as string,
    scope: value.scope,
    facet: value.facet as Facet,
    capability,
    signature: value.signature,
    ...(parent ? { parent } : {}),
  };
}
export async function creationOriginFrame(
  input: Omit<CreationOrigin, "signature">,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = creationOrigin({ ...input, signature: "" });
  const fields = [
    value.tenant,
    value.id,
    value.scope,
    value.facet,
    await digest(
      signedPacketFrame(
        await creationCapabilityFrame(value.capability),
        value.capability.signature,
      ),
    ),
  ];
  if (value.parent)
    fields.push(
      await digest(
        signedPacketFrame(
          await creationOriginFrame(value.parent),
          value.parent.signature,
        ),
      ),
    );
  return frame(
    value.parent ? "sortsys/created-area/v2" : "sortsys/created-area/v1",
    fields,
  );
}
export async function createOrigin(
  input: Omit<CreationOrigin, "signature">,
  creator: CryptoKey,
): Promise<CreationOrigin> {
  return {
    ...creationOrigin({ ...input, signature: "" }),
    signature: await sign(creator, await creationOriginFrame(input)),
  };
}
export async function verifyCreationOrigin(
  input: unknown,
  authority: (generation: string) => CryptoKey,
): Promise<CreationOrigin> {
  const value = creationOrigin(input);
  await verifyCreationCapability(
    value.capability,
    authority(value.capability.generation),
  );
  if (value.parent) await verifyCreationOrigin(value.parent, authority);
  await verify(
    await importSigningKey(value.capability.creator.signingKey),
    value.signature,
    await creationOriginFrame(value),
  );
  return value;
}
export function creationRules(origin: CreationOrigin): Rule[] {
  return [
    ...new Set([
      origin.capability.creator.user,
      ...origin.capability.readers.map((reader) => reader.user),
    ]),
  ].map((subject) => ({
    subject,
    scope: origin.scope,
    facet: origin.facet,
    effect: "allow",
    actions: ["read", "create", "update", "delete"],
  }));
}
export function creationAuthor(origin: CreationOrigin): string {
  return `creator:${origin.capability.creator.user}:${origin.capability.generation}`;
}
