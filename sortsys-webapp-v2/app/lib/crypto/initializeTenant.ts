import type { Client, MutateInput, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  certifyCreationCapability,
  CREATION_NAMESPACES,
  frame,
  InvalidProtectedData,
  randomSecret,
  sign,
  verify,
} from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "../data/database";
import { provisionOwnedCollections } from "../data/prepareCollections";
import { protectedCollection, required } from "../data/protectedObjects";
import {
  organizationArea,
  organizationObject,
  organizationPayload,
  PRINT_COLLECTION,
} from "../data/organizationData";
import { PRINT_OBJECT, printTemplatePayload } from "../data/printTemplateData";
import { initializeDeliveryRegistry } from "../data/deliveryRegistry";
import { TOOL_INDEX, TOOL_INDEX_MODEL } from "../data/toolData";
import { PERSONNEL_FACETS, personnelCollection } from "../data/personnelData";
import { openAuthority } from "./setup";
import { trustedHistory, unlockedAccount } from "./session";
import { readInitializationSource } from "./initializationSource";
import { uiText } from "../i18n";
import { initialOwnerCollections } from "./initializationAreas";
import { DEFAULT_OFFER_NUMBERING } from "../invoiceNumbering";

type Completion = MutateInput<"zerotrust.setup.complete">;
type Status = QueryResult<"zerotrust.status">;

function initialRecords() {
  const organization = [
    ["profile", { companyName: null, address: null }],
    ["numbering", { scheme: "sequential", startNumber: "1" }],
    ["offerNumbering", DEFAULT_OFFER_NUMBERING],
  ] as const;
  return [
    ...organization.map(([kind, value]) => ({
      area: organizationArea(kind),
      id: organizationObject(kind),
      value: { format: "sortsys-organization-v1", kind, value },
      validate(input: unknown) {
        organizationPayload(input, organizationObject(kind), kind);
      },
    })),
    {
      area: PRINT_COLLECTION,
      id: PRINT_OBJECT,
      value: { format: "sortsys-print-template-v1", source: null, assets: [] },
      validate(input: unknown) {
        printTemplatePayload(input, PRINT_OBJECT);
      },
    },
    {
      area: TOOL_INDEX,
      id: TOOL_INDEX.prefix,
      value: { format: "sortsys-tool-index-v1", entries: [] },
      validate(input: unknown) {
        TOOL_INDEX_MODEL.decode(input, TOOL_INDEX.prefix, TOOL_INDEX);
      },
    },
  ];
}

export function initializationFrame(
  input: Omit<Completion, "signature">,
): Uint8Array<ArrayBuffer> {
  return frame("sortsys/tenant-initialized/v1", [
    input.tenant,
    input.generation,
    input.subject,
    input.policyVersion,
    String(input.domains.length),
    ...input.domains,
    String(input.objects.length),
    ...input.objects,
  ]);
}

export async function verifyTenantInitialized(
  client: Client,
  status: Status,
): Promise<boolean> {
  const completion = status.initialization;
  if (!completion) return false;
  const account = unlockedAccount();
  if (
    !account ||
    completion.tenant !== account.tenant ||
    status.tenant !== account.tenant
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  if (
    completion.generation !== status.generation ||
    status.generation !== history.current.generation
  ) {
    throw new InvalidProtectedData();
  }
  await verify(
    history.authority(completion.generation),
    completion.signature,
    initializationFrame(completion),
  );
  return true;
}

/** New tenants start here. No old server, source tables or migration phase is involved. */
export async function initializeTenant(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<Completion> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  live();
  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  if (await verifyTenantInitialized(client, status))
    return status.initialization!;
  if (!status.canInitialize || !status.profile)
    throw new InvalidProtectedData();
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  const subject = `user:${session.user.id}`;
  if (
    !session.roles.includes(":admin") ||
    status.profile.owner.user !== subject
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  const authority = await openAuthority(client, status.profile);
  if (history.current.context !== undefined) {
    const source = await readInitializationSource(client, signal);
    live();
    if (!source?.completion)
      throw new Error(
        uiText(
          "Die gewählte Sicherung muss vor dem Abschluss der Einrichtung vollständig übernommen werden.",
          "The selected backup must be fully adopted before setup can be completed.",
        ),
      );
  }
  const collections = initialOwnerCollections(session.user.id);
  await provisionOwnedCollections(client, subject, collections, signal);
  live();
  // One list drives both creation and the signed completion inventory.
  // Existing backup contents are validated and retained, never reset.
  const records = initialRecords();
  for (const record of records) {
    const area = await protectedCollection(client, record.area, signal);
    try {
      const existing = await area.read(record.id);
      if (existing.length) {
        if (existing.length !== 1) throw new InvalidProtectedData();
        record.validate(existing[0]!.value);
      } else {
        const packet = await area.packet(record.id, record.value);
        await area.write([packet]);
      }
    } finally {
      area.close();
    }
    live();
  }
  const { verifyPersonnelRecord } = await import("../data/personnel");
  await verifyPersonnelRecord(client, signal, session.user.id, driver);
  for (const namespace of CREATION_NAMESPACES) {
    const [existing, error] = await client.query(
      "zerotrust.creations.capability",
      { namespace },
      { strategy: "network-only" },
    );
    if (error) throw error;
    if (!existing) {
      const capability = await certifyCreationCapability(
        {
          tenant: account.tenant,
          id: `create_${base64(randomSecret())}`,
          generation: history.current.generation,
          namespace,
          creator: status.profile.owner,
          readers: [status.profile.owner],
        },
        authority,
      );
      await required(client.mutate("zerotrust.creations.grant", capability));
    }
    live();
  }
  await initializeDeliveryRegistry(client, signal);
  live();
  const current = await required(
    client.query("zerotrust.policy.get", undefined, {
      strategy: "network-only",
    }),
  );
  const completion = {
    tenant: account.tenant,
    generation: history.current.generation,
    subject,
    policyVersion: current.version,
    domains: collections.map((area) => area.domain).sort(),
    objects: [
      ...records.map((record) => record.id),
      ...PERSONNEL_FACETS.map(
        (facet) => personnelCollection(session.user.id, facet).prefix,
      ),
    ].sort(),
  };
  const signature = await sign(authority, initializationFrame(completion));
  let failure: unknown;
  try {
    await required(
      client.mutate("zerotrust.setup.complete", { ...completion, signature }),
    );
  } catch (error) {
    failure = error;
  }
  live();
  const saved = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  if (!(await verifyTenantInitialized(client, saved)))
    throw failure ?? new InvalidProtectedData();
  await client.invalidate("zerotrust.status");
  return saved.initialization!;
}
