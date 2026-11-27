import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
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
import { compilePolicy, type Policy, type Rule } from "./policy";
import type { Facet } from "./objects";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./core/certificates";
import {
  resourceAccessState,
  resourceCommand,
  verifyResourceAccess,
  verifyResourceCommand,
  type ResourceAccessState,
  type ResourceCommand,
} from "./core/resourceAccess";

export const PROJECT_CREATION_SCOPE = "create:project";
export const TOOL_RETURN_PURPOSE = "tool-return";
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
export const CREATION_NAMESPACES = Object.freeze(
  Object.keys(CREATION_FACETS) as CreationNamespace[],
);
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
export type CreationOrigin = CreationParent & {
  parent?: CreationParent;
  assignee?: IdentityCertificate;
  access?: ResourceAccessState;
  returned?: ResourceCommand;
};

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
  return (await verifyCapabilityProof(input, authority)).certificate;
}

function verifyCapabilityProof(input: unknown, authority: CryptoKey) {
  const value = creationCapability(input);

  return delegations.verifyProof(
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
  const hasAssignee =
    !!input && typeof input === "object" && Object.hasOwn(input, "assignee");
  const hasAccess =
    !!input && typeof input === "object" && Object.hasOwn(input, "access");
  const hasReturn =
    !!input && typeof input === "object" && Object.hasOwn(input, "returned");
  const value = record(input, [
    "tenant",
    "id",
    "scope",
    "facet",
    "capability",
    "signature",
    ...(hasParent ? ["parent"] : []),
    ...(hasAssignee ? ["assignee"] : []),
    ...(hasAccess ? ["access"] : []),
    ...(hasReturn ? ["returned"] : []),
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
  let assignee: IdentityCertificate | undefined;
  let access: ResourceAccessState | undefined;
  if (hasAssignee) {
    assignee = identityCertificate(value.assignee);
    if (
      resource.namespace !== "tool-tracking" ||
      !["master-data", "scope"].includes(value.facet as string) ||
      assignee.tenant !== capability.tenant ||
      assignee.generation !== capability.generation ||
      [capability.creator, ...capability.readers].some(
        (member) => member.user === assignee!.user,
      )
    )
      throw new InvalidProtectedData();
  }
  if (hasAccess) {
    if (
      resource.namespace !== "tool-tracking" ||
      !["master-data", "scope"].includes(value.facet as string)
    )
      throw new InvalidProtectedData();
    access = resourceAccessState(value.access);
  }
  let returned: ResourceCommand | undefined;
  if (hasReturn) {
    if (!access?.commandBinding) throw new InvalidProtectedData();
    returned = resourceCommand(value.returned);
    if (
      (access.active && returned.revision !== access.revision) ||
      (!access.active && BigInt(returned.revision) >= BigInt(access.revision))
    )
      throw new InvalidProtectedData();
  }
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
    ...(assignee ? { assignee } : {}),
    ...(access ? { access } : {}),
    ...(returned ? { returned } : {}),
  };
}
export async function creationOriginFrame(
  input: Omit<CreationOrigin, "signature">,
): Promise<Uint8Array<ArrayBuffer>> {
  return originFrame(creationOrigin({ ...input, signature: "" }));
}

async function originFrame(
  value: CreationOrigin,
  checked?: {
    capability: Uint8Array<ArrayBuffer>;
    parent: Uint8Array<ArrayBuffer> | undefined;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const capabilityFrame =
    checked?.capability ?? (await creationCapabilityFrame(value.capability));
  const fields = [
    value.tenant,
    value.id,
    value.scope,
    value.facet,
    await digest(signedPacketFrame(capabilityFrame, value.capability.signature)),
  ];
  if (value.parent)
    fields.push(
      await digest(
        signedPacketFrame(
          checked?.parent ?? (await originFrame(value.parent)),
          value.parent.signature,
        ),
      ),
    );
  if (value.assignee)
    fields.push(
      await digest(
        signedPacketFrame(
          identityCertificateFrame(value.assignee),
          value.assignee.signature,
        ),
      ),
    );
  let format = "sortsys/created-area/v1";
  if (value.assignee) format = "sortsys/created-area-assignee/v1";
  else if (value.parent) format = "sortsys/created-area/v2";
  return frame(format, fields);
}
export async function createOrigin(
  input: Omit<CreationOrigin, "signature">,
  creator: CryptoKey,
): Promise<CreationOrigin> {
  const value = creationOrigin({ ...input, signature: "" });
  return {
    ...value,
    signature: await sign(creator, await originFrame(value)),
  };
}

export type CreationRenewal = {
  origins: readonly CreationOrigin[];
  object: string;
  revision: string;
  packetSignature: string;
};

/** A fresh tenant authority confirms an existing booking without reviving any
 * historical member grant. The exact ciphertext source prevents stale renewal. */
export async function creationRenewalFrame(
  input: CreationRenewal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (input.origins.length !== 2) throw new InvalidProtectedData();
  const origins = input.origins.map(creationOrigin);
  const master = origins[0]!;
  if (
    master.capability.namespace !== "tool-tracking" ||
    input.object !== `${master.scope}:master-data:record`
  )
    throw new InvalidProtectedData();
  revision(input.revision);
  sized(input.packetSignature, 64);
  const hashes = [];
  for (const [index, origin] of origins.entries()) {
    if (
      origin.tenant !== master.tenant ||
      origin.scope !== master.scope ||
      origin.facet !== ["master-data", "scope"][index] ||
      origin.capability.signature !== master.capability.signature ||
      origin.assignee ||
      origin.access ||
      origin.returned ||
      origin.parent
    )
      throw new InvalidProtectedData();
    hashes.push(
      await digest(
        signedPacketFrame(await creationOriginFrame(origin), origin.signature),
      ),
    );
  }
  return frame("sortsys/created-booking-renewal/v1", [
    master.tenant,
    master.capability.generation,
    master.scope,
    input.object,
    input.revision,
    input.packetSignature,
    ...hashes,
  ]);
}
export async function verifyCreationOrigin(
  input: unknown,
  authority: (generation: string) => CryptoKey,
): Promise<CreationOrigin> {
  return (await verifyCreationProof(input, authority)).origin;
}

export async function verifyCreationProof(
  input: unknown,
  authority: (generation: string) => CryptoKey,
) {
  const origin = creationOrigin(input);
  const frame = await verifyOriginFrame(origin, authority);

  return { origin, frame };
}

async function verifyOriginFrame(
  value: CreationOrigin,
  authority: (generation: string) => CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const { frame: capabilityFrame } = await verifyCapabilityProof(
    value.capability,
    authority(value.capability.generation),
  );

  const parentFrame = value.parent
    ? await verifyOriginFrame(value.parent, authority)
    : undefined;

  if (value.assignee)
    await verify(
      authority(value.capability.generation),
      value.assignee.signature,
      identityCertificateFrame(value.assignee),
    );

  // Bind the exact verified frames rather than rebuilding their proofs.
  const message = await originFrame(value, {
    capability: capabilityFrame,
    parent: parentFrame,
  });
  await verify(
    await importSigningKey(value.capability.creator.signingKey),
    value.signature,
    message,
  );

  if (value.access)
    await verifyResourceAccess(
      value.access,
      {
        tenant: value.tenant,
        resource: value.scope,
        object: `${value.scope}:master-data:record`,
        generation: value.capability.generation,
        binding: await creationResourceBinding(value),
      },
      authority,
    );

  if (value.returned) {
    const binding = value.access?.commandBinding;
    if (!binding) throw new InvalidProtectedData();
    await verifyResourceCommand(value.returned, {
      tenant: value.tenant,
      purpose: TOOL_RETURN_PURPOSE,
      binding,
    });
  }

  return message;
}

export function isActiveToolBookingOrigin(origin: CreationOrigin): boolean {
  return origin.access?.active === true && origin.returned === undefined;
}
export async function creationAssignmentBinding(
  origin: CreationOrigin,
): Promise<string> {
  if (!origin.assignee) throw new InvalidProtectedData();
  return digest(
    frame("sortsys/creation-assignment/v1", [
      origin.tenant,
      origin.scope,
      origin.capability.signature,
      origin.assignee.signature,
    ]),
  );
}

/** A booking can predate its assignee's certified identity. Its signed live
 * state remains bound to the certified resource even before a reader exists. */
export async function creationResourceBinding(
  origin: CreationOrigin,
): Promise<string> {
  if (origin.assignee) return creationAssignmentBinding(origin);
  if (
    creationResource(origin.scope)?.namespace !== "tool-tracking" ||
    !["master-data", "scope"].includes(origin.facet)
  )
    throw new InvalidProtectedData();
  return digest(
    frame("sortsys/created-booking-state/v1", [
      origin.tenant,
      origin.scope,
      origin.capability.signature,
    ]),
  );
}
export function creationRecipients(
  origin: CreationOrigin,
): IdentityCertificate[] {
  return [
    origin.capability.creator,
    ...origin.capability.readers,
    ...(origin.assignee ? [origin.assignee] : []),
  ];
}
export function activeBookingReadScope(scope: string): string {
  if (creationResource(scope)?.namespace !== "tool-tracking") {
    throw new InvalidProtectedData();
  }
  return `active-tool:${scope}`;
}

export function creationRules(
  origin: CreationOrigin,
  permissions?: Policy,
): Rule[] {
  if (permissions && permissions.tenant !== origin.tenant) {
    throw new InvalidProtectedData();
  }
  const rules: Rule[] = [
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
  if (origin.assignee && isActiveToolBookingOrigin(origin))
    rules.push({
      subject: origin.assignee.user,
      scope: origin.scope,
      facet: origin.facet,
      effect: "allow",
      actions: ["read"],
    });
  if (
    permissions &&
    isActiveToolBookingOrigin(origin) &&
    origin.capability.namespace === "tool-tracking" &&
    ["master-data", "scope"].includes(origin.facet)
  ) {
    // The root-signed intent names a separate capability scope. It grants no
    // ordinary domain access until this verified live state activates it.
    const intent = activeBookingReadScope(origin.scope);
    const subjects = new Set(
      permissions.rules
        .filter((rule) => rule.scope === intent && rule.facet === origin.facet)
        .map((rule) => rule.subject),
    );
    for (const subject of subjects) {
      if (
        compilePolicy(permissions, [subject]).allows(
          intent,
          origin.facet,
          "read",
        )
      ) {
        rules.push({
          subject,
          scope: origin.scope,
          facet: origin.facet,
          effect: "allow",
          actions: ["read"],
        });
      }
    }
  }
  return rules;
}
export function creationAuthor(origin: CreationOrigin): string {
  return `creator:${origin.capability.creator.user}:${origin.capability.generation}`;
}
