import type { Client } from "@sortsys/v2-client";
import { arrayBatches, createWeakPairCache, mapConcurrent } from "@sortsys/zerotrust";
import {
  InvalidProtectedData,
  keyAuthority,
  keyAuthorityAuthor,
  verifyKeyAuthority,
  certifyKeyAuthority,
  compilePolicy,
  type Policy,
  type DomainDefinition,
  type KeyAuthority,
  sealedBox,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { unlockedAccount, type trustedHistory } from "./session";

const certificates = createWeakPairCache<
  Client,
  object,
  Map<string, Promise<KeyAuthority>>
>(() => new Map());

/** Issue only for explicitly edited areas. Ordinary read/write changes do not
 * create certificates or scan unrelated members and domains. */
export async function provisionMemberKeyAuthorities(
  client: Client,
  input: {
    account: { tenant: string };
    history: Awaited<ReturnType<typeof trustedHistory>>;
    authority: CryptoKey;
    permissions: Policy;
    subject: string;
    areas: readonly Pick<DomainDefinition, "scope" | "facet">[];
    live(): void;
    signal: AbortSignal;
  },
): Promise<void> {
  input.live();
  const access = compilePolicy(input.permissions, [input.subject]);
  const selected = new Map<string, Pick<DomainDefinition, "scope" | "facet">>();
  for (const area of input.areas) {
    if (
      access.allows(area.scope, area.facet, "grant") &&
      access.allows(area.scope, area.facet, "read")
    ) {
      selected.set(`${area.scope}\0${area.facet}`, area);
    }
  }
  if (!selected.size) return;
  const holder = input.history.identityCertificate(input.subject);
  const authorities = await mapConcurrent(
    [...selected.values()],
    4,
    async (area) => {
      input.live();
      const certificate = await certifyKeyAuthority(
        {
          tenant: input.account.tenant,
          generation: input.history.current.generation,
          scope: area.scope,
          facet: area.facet,
          holder,
        },
        input.authority,
      );
      input.live();
      return certificate;
    },
  );

  for (const batch of arrayBatches(authorities, 32)) {
    input.signal.throwIfAborted();
    input.live();

    let failure: unknown;
    try {
      const [, error] = await client.mutate(
        "zerotrust.keyAuthorities.register",
        { authorities: batch },
        { signal: input.signal },
      );
      failure = error;
    } catch (error) {
      failure = error;
    }
    input.live();
    try {
      const saved = await required(
        client.query(
          "zerotrust.keyAuthorities.forAreas",
          {
            areas: batch.map((certificate) => ({
              scope: certificate.scope,
              facet: certificate.facet,
              holder: input.subject,
            })),
          },
          { strategy: "network-only" },
        ),
      );
      input.live();
      if (!Array.isArray(saved) || saved.length !== batch.length)
        throw new InvalidProtectedData();
      await mapConcurrent(batch, 4, async (certificate, index) => {
        const checked = await verifyKeyAuthority(
          saved[index],
          {
            tenant: input.account.tenant,
            generation: certificate.generation,
            scope: certificate.scope,
            facet: certificate.facet,
            holder: input.subject,
          },
          input.history.authority(certificate.generation),
        );
        input.live();
        if (checked.signature !== certificate.signature)
          throw new InvalidProtectedData();
      });
    } catch (error) {
      input.live();
      throw failure ?? error;
    }
  }
}

/** Only public certificates are shared. Each caller independently verifies its
 * expected area and lifetime before using the corresponding encryption key. */
export async function readBoxKeyAuthority(
  client: Client,
  input: {
    box: unknown;
    definition: Pick<
      DomainDefinition,
      "tenant" | "scope" | "facet" | "keyAuthority"
    >;
    history: { authority(generation: string): CryptoKey };
    live(): void;
    keyAuthority?: KeyAuthority;
  },
): Promise<KeyAuthority | undefined> {
  input.live();
  const box = sealedBox(input.box);
  const signature = box.author.startsWith("delegate:")
    ? box.author.slice("delegate:".length)
    : undefined;
  if (!signature) {
    if (input.keyAuthority) throw new InvalidProtectedData();
    return undefined;
  }
  sized(signature, 64);
  let certificate = input.keyAuthority;
  if (!certificate && input.definition.keyAuthority?.signature === signature) {
    certificate = input.definition.keyAuthority;
  }
  if (!certificate) {
    const account = unlockedAccount();
    if (!account) throw new InvalidProtectedData();
    const cache = certificates.getOrCreate(client, account);
    let pending = cache.get(signature);
    if (!pending) {
      pending = (async () => {
        const result = await required(
          client.query(
            "zerotrust.keyAuthorities.get",
            { signature },
            { strategy: "network-only" },
          ),
        );
        if (unlockedAccount() !== account || !client.loggedIn())
          throw new InvalidProtectedData();
        const parsed = keyAuthority(result);
        if (parsed.signature !== signature) throw new InvalidProtectedData();
        return verifyKeyAuthority(
          parsed,
          {
            tenant: account.tenant,
            generation: parsed.generation,
            scope: parsed.scope,
            facet: parsed.facet,
          },
          input.history.authority(parsed.generation),
        );
      })();
      if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
      cache.set(signature, pending);
    }
    try {
      certificate = await pending;
    } catch (error) {
      if (cache.get(signature) === pending) cache.delete(signature);
      throw error;
    }
  }
  input.live();
  if (keyAuthorityAuthor(certificate) !== box.author)
    throw new InvalidProtectedData();
  const checked = await verifyKeyAuthority(
    certificate,
    {
      tenant: input.definition.tenant,
      generation: certificate.generation,
      scope: input.definition.scope,
      facet: input.definition.facet,
    },
    input.history.authority(certificate.generation),
  );
  input.live();
  return checked;
}
