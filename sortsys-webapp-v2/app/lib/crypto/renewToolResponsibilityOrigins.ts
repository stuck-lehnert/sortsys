import type { Client } from "@sortsys/v2-client";
import {
  base64,
  certifyCreationCapability,
  createOrigin,
  creationRenewalFrame,
  InvalidProtectedData,
  randomSecret,
  sign,
  verifyCreationOrigin,
  type CreationOrigin,
} from "@sortsys/zerotrust/sortsys";
import type { administratorPolicyContext } from "./administration";
import type { DuckDriver } from "../data/database";
import { publicId } from "../data/products";
import { acquireDataRuntime } from "../data/runtime/session";
import { toolDomain, toolRequest } from "../data/toolData";
import { required } from "../protectedResult";

/** Recovery invalidates old grants. A current administrator can confirm the
 * existing resource anew; this step itself gives no responsible member keys. */
export async function renewToolResponsibilityOrigins(
  client: Client,
  context: Awaited<ReturnType<typeof administratorPolicyContext>>,
  origins: ReadonlyMap<string, CreationOrigin>,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<boolean> {
  const selected = context.domains.flatMap((domain) => {
    const part = toolDomain(domain.id);
    if (
      !part ||
      part.namespace !== "tool-tracking" ||
      part.facet !== "master-data" ||
      origins.has(domain.id)
    )
      return [];
    return [toolRequest("tool-tracking", part.id, "master-data")];
  });
  if (!selected.length) return false;
  const lease = acquireDataRuntime(client, signal, driver);
  const eligible = await (async () => {
    try {
      return await lease.runtime.read(selected, (view) => {
        const result = [];
        for (const request of selected) {
          const documents = view.documents(request);
          if (!documents.length) continue;
          if (documents.length !== 1) throw new InvalidProtectedData();
          const document = documents[0]!;
          if (document.value.deleted) continue;
          const row = document.value.rows[0]!.values;
          const endedAt = view.row("tool_trackings", { id: row.id }).require("ended_at");
          if (endedAt !== null || row.responsible_user_id === null)
            continue;
          try {
            context.history.identityCertificate(
              `user:${publicId(row.responsible_user_id)}`,
            );
          } catch (error) {
            if (error instanceof InvalidProtectedData) continue;
            throw error;
          }
          if (!document.signature) throw new InvalidProtectedData();
          result.push({ request, document });
        }
        return result;
      });
    } finally {
      lease.close();
    }
  })();
  if (!eligible.length) return false;
  context.live();
  const creator = context.history.identityCertificate(
    context.account.vault.subject,
  );
  const capability = await certifyCreationCapability(
    {
      tenant: context.account.tenant,
      id: `create_${base64(randomSecret())}`,
      generation: context.history.current.generation,
      namespace: "tool-tracking",
      creator,
      readers: [creator],
    },
    context.authority,
  );
  // Each renewal advances the same tenant inventory. Keep these dependent
  // writes sequential; the independent confirmation reads still batch.
  for (const { request, document } of eligible) {
    context.live();
    const renewed = [];
    for (const facet of ["master-data", "scope"] as const) {
      renewed.push(
        await createOrigin(
          {
            tenant: context.account.tenant,
            id: `${request.area.scope}:${facet}`,
            scope: request.area.scope,
            facet,
            capability,
          },
          context.account.identity.signingKey.privateKey,
        ),
      );
    }
    const input = {
      origins: renewed,
      object: document.id,
      revision: document.revision,
      packetSignature: document.signature!,
    };
    const proof = await sign(
      context.authority,
      await creationRenewalFrame(input),
    );
    let failure: unknown;
    try {
      await required(
        client.mutate(
          "zerotrust.creations.renew",
          { ...input, proof },
          { signal },
        ),
      );
    } catch (error) {
      failure = error;
    }
    // Neither a successful acknowledgement nor a lost reply proves that the
    // exact certificates were stored. Verify both facets before proceeding.
    await Promise.all(
      renewed.map(async (origin) => {
        const [value, error] = await client.query(
          "zerotrust.creations.origin",
          { domain: origin.id },
          { strategy: "network-only" },
        );
        if (error || !value)
          throw failure ?? error ?? new InvalidProtectedData();
        const checked = await verifyCreationOrigin(
          value,
          context.history.authority,
        );
        if (checked.signature !== origin.signature)
          throw failure ?? new InvalidProtectedData();
      }),
    );
    context.live();
  }
  return true;
}
