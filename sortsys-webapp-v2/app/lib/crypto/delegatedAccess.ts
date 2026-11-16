import type { Client } from "@sortsys/v2-client";
import {
  administrativeProfileKey,
  administrativeProfiles,
  compilePolicy,
  compileReadership,
  createManagedDomain,
  InvalidProtectedData,
  signAdministrativePolicy,
  verifyKeyAuthority,
  type SignedPolicy,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "./accessContext";
import {
  actionPatch,
  accessActions,
  compileManagedAccess,
  sameAccess,
  withActions,
  type ActionPatch,
} from "./accessProfiles";
import { prepareHistoricalKeyGrants } from "./historicalKeyGrants";
import { publishSignedPolicy, readVerifiedPolicy } from "./policy";
import { publishAccessRotations } from "../data/accessPublication";
import { isWriteConflict, ProtectedWriteConflict } from "../data/atomicWrites";
import { required, type Collection } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";

type Change = { area: Collection; patch: ActionPatch };

function compareProfiles(
  first: { subject: string; scope: string; facet: string },
  second: { subject: string; scope: string; facet: string },
): number {
  const left = administrativeProfileKey(first);
  const right = administrativeProfileKey(second);
  if (left === right) return 0;
  if (left < right) return -1;
  return 1;
}

/** All plaintext here is public authorization metadata. Content keys are only
 * opened inside the framework and immediately resealed for certified readers. */
export async function changeDelegatedAreaActions(
  client: Client,
  subject: string,
  changes: readonly Change[],
  signal: AbortSignal,
): Promise<void> {
  if (
    !changes.length ||
    changes.length > 64 ||
    !/^user:[1-9a-v][0-9a-v]{0,12}$/.test(subject)
  ) {
    throw new InvalidProtectedData();
  }
  const selected = [...new Set(changes.map(({ area }) => area.domain))];
  for (let attempt = 0; ; attempt++) {
    try {
      const context = await verifiedAccessContext(
        client,
        signal,
        selected.length <= 16 ? { domains: selected } : {},
      );
      if (subject === context.subject) throw new InvalidProtectedData();
      const actor = compilePolicy(context.permissions, [context.subject]);
      const target = compilePolicy(context.permissions, [subject]);
      const identity = context.history.identityCertificate(context.subject);
      const recipient = await required(
        client.query(
          "zerotrust.identities.get",
          { subject },
          { strategy: "network-only" },
        ),
      );
      context.live();
      if (
        recipient.signature !==
        context.history.identityCertificate(subject).signature
      )
        throw new InvalidProtectedData();
      const current = await readVerifiedPolicy(client, context);
      if (current.permissions.version !== context.rootPolicy.version)
        throw new ProtectedWriteConflict();
      const { permissions, ...proof } = current;
      const previous: SignedPolicy = { ...permissions, ...proof };
      const root = previous.administration?.root ?? previous;
      const version = (BigInt(previous.version) + 1n).toString();
      const profiles = new Map(
        (previous.administration?.profiles ?? []).map((profile) => [
          administrativeProfileKey(profile),
          profile,
        ]),
      );
      const access = compileManagedAccess(context.permissions, subject);
      let changed = false;
      const seen = new Set<string>();
      for (const { area, patch: input } of changes) {
        const patch = actionPatch(input);
        const domain = context.domains.find(
          (domain) => domain.id === area.domain,
        );
        if (
          !domain ||
          domain.scope !== area.scope ||
          domain.facet !== area.facet
        )
          throw new InvalidProtectedData();
        const id = administrativeProfileKey({
          subject,
          scope: area.scope,
          facet: area.facet,
        });
        if (
          seen.has(id) ||
          patch.grant === true ||
          target.allows(area.scope, area.facet, "grant") ||
          !actor.allows(area.scope, area.facet, "grant") ||
          !actor.allows(area.scope, area.facet, "read")
        ) {
          throw new InvalidProtectedData();
        }
        seen.add(id);
        const before = access(area);
        const next = withActions(before, patch);
        if (sameAccess(before, next)) continue;
        const profile = await administrativeProfiles.sign(
          {
            tenant: context.account.tenant,
            rootSignature: root.signature,
            version,
            subject,
            scope: area.scope,
            facet: area.facet,
            actions: [...accessActions(next)].filter(
              (action) => action !== "grant",
            ),
            author: identity,
          },
          context.account.identity.signingKey.privateKey,
        );
        context.live();
        profiles.set(id, profile);
        changed = true;
      }
      if (changed) {
        const next = await signAdministrativePolicy(
          {
            root,
            profiles: [...profiles.values()].sort(compareProfiles),
            author: identity,
            previousSignature: previous.signature,
            version,
          },
          context.account.identity.signingKey.privateKey,
        );
        context.live();
        await publishSignedPolicy(client, context, next);
      }
      await finishDelegatedAccessChanges(
        client,
        changes.map(({ area }) => area),
        signal,
      );
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!isWriteConflict(error) || attempt >= 2) throw error;
    }
  }
}

/** Rotation markers are durable. An interrupted permission command resumes
 * against a new verified policy, rather than publishing an old recipient set. */
export async function finishDelegatedAccessChanges(
  client: Client,
  areas: readonly Collection[],
  signal: AbortSignal,
): Promise<void> {
  const expected = new Map(areas.map((area) => [area.domain, area]));
  const selected = [...expected.keys()];
  for (let iteration = 0; iteration < 2001; iteration++) {
    const context = await verifiedAccessContext(
      client,
      signal,
      selected.length > 0 && selected.length <= 16
        ? { domains: [...selected] }
        : {},
    );
    const actor = compilePolicy(context.permissions, [context.subject]);
    const pending = context.domains
      .filter((domain) => expected.has(domain.id) && domain.rotationRequired)
      .slice(0, 8);
    if (!pending.length) {
      await client.invalidate("products.list");
      return;
    }
    const readership = compileReadership(context.permissions);
    const rotations = await mapConcurrent(pending, 4, async (domain) => {
      const collection = expected.get(domain.id)!;
      if (
        domain.scope !== collection.scope ||
        domain.facet !== collection.facet
      )
        throw new InvalidProtectedData();
      const area = {
        tenant: context.account.tenant,
        id: domain.id,
        scope: collection.scope,
        facet: collection.facet,
        generation: domain.generation,
      };
      if (
        !actor.allows(area.scope, area.facet, "grant") ||
        !actor.allows(area.scope, area.facet, "read")
      )
        throw new InvalidProtectedData();
      const input = await required(
        client.query(
          "zerotrust.keyAuthorities.forArea",
          { scope: area.scope, facet: area.facet },
          { strategy: "network-only" },
        ),
      );
      context.live();
      const certificate = await verifyKeyAuthority(
        input,
        {
          tenant: context.account.tenant,
          generation: context.history.current.generation,
          scope: area.scope,
          facet: area.facet,
          holder: context.subject,
        },
        context.history.authority(context.history.current.generation),
      );
      context.live();
      if (
        certificate.holder.signature !==
        context.history.identityCertificate(context.subject).signature
      )
        throw new InvalidProtectedData();
      const readers = readership(area.scope, area.facet).map((subject) => ({
        subject,
        identity: context.history.identityCertificate(subject),
      }));
      const grants = await prepareHistoricalKeyGrants(client, {
        area,
        owner: {
          subject: context.subject,
          privateKey: context.account.identity.encryptionKey.privateKey,
        },
        authority: {
          generation: context.history.current.generation,
          privateKey: context.account.identity.signingKey.privateKey,
          keyAuthority: certificate,
        },
        history: context.history.authority,
        readers,
        signal,
        live: context.live,
      });
      const { definition } = await createManagedDomain({
        ...area,
        generation: (BigInt(area.generation) + 1n).toString(),
        policyVersion: context.rootPolicy.version,
        keyAuthority: certificate,
        signingKey: context.account.identity.signingKey.privateKey,
        recovery: {
          encryptionKey: context.history.current.recoveryEncryptionKey,
          signingKey: context.history.current.recoverySigningKey,
        },
        readers,
      });
      context.live();
      return { grants, definition };
    });
    await publishAccessRotations(
      client,
      context.rootPolicy.version,
      rotations,
      signal,
    );
  }
  throw new InvalidProtectedData();
}
