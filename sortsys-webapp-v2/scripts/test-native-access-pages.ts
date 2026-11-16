import assert from "node:assert/strict";
import {
  RpcClientError,
  type Client,
  type QueryResult,
} from "@sortsys/v2-client";
import {
  allows,
  base64,
  certifyCreationCapability,
  createDomain,
  domainFrame,
  domainBoxSigner,
  openBox,
  sealBox,
  publicIdentity,
  sign,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../app/lib/crypto/administration";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import {
  publishVerifiedPolicy,
  readVerifiedPolicy,
} from "../app/lib/crypto/policy";
import { createResourceAreas } from "../app/lib/data/createProjectArea";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { newProductRowId, publicId } from "../app/lib/data/products";

type RequestHook = (
  url: URL,
  next: (replacement?: URL) => Promise<Response>,
  options?: RequestInit,
) => Promise<Response>;

export async function exerciseNativeAccessPages(
  owner: Client,
  peer: Client,
  endpoints: readonly string[],
  setRequestHook: (hook: RequestHook | null) => void,
) {
  const signal = new AbortController().signal;
  const context = await administratorContext(owner, signal);
  const subject = `user:${context.session.user.id}`;
  const identity = context.history.identityCertificate(subject);
  await required(
    owner.mutate(
      "zerotrust.creations.grant",
      await certifyCreationCapability(
        {
          tenant: context.account.tenant,
          generation: context.history.current.generation,
          id: "native_access_pages",
          namespace: "tool",
          creator: identity,
          readers: [identity],
        },
        context.authority,
      ),
    ),
  );
  const makeArea = () => {
    const scope = `tool:${publicId(newProductRowId())}`;
    return {
      domain: `${scope}:master-data`,
      scope,
      facet: "master-data" as const,
      prefix: `${scope}:master-data:record`,
    };
  };
  const areas = Array.from({ length: 130 }, makeArea);

  // Continue the same authenticated session on the other production router.
  // No sticky session, shared process memory or mock handler participates.
  let routed = 0;
  const definitionCounts: number[] = [];
  setRequestHook(async (url, next, options) => {
    if (
      url.pathname === "/zerotrust.domains.putMany" &&
      typeof options?.body === "string"
    ) {
      const body = JSON.parse(options.body);
      definitionCounts.push(body["0"].json.domains.length);
    }
    if (url.pathname.slice(1).split(",").includes("zerotrust.access.page")) {
      routed++;
      return next(new URL(url.pathname + url.search, endpoints[0]));
    }
    return next();
  });
  try {
    await createResourceAreas(owner, areas, "tool", signal);
    assert.deepEqual(definitionCounts, [32, 32, 32, 32, 2]);
    const oversized = await Promise.all(
      areas
        .slice(0, 33)
        .map((area) =>
          required(
            owner.query(
              "zerotrust.domains.get",
              { domain: area.domain, generation: "1" },
              { strategy: "network-only" },
            ),
          ),
        ),
    );
    const rejected = await owner.mutate("zerotrust.domains.putMany", {
      domains: oversized,
    });
    assert.equal(rejected[0], null);
    assert.ok(rejected[1] instanceof RpcClientError);
    assert.equal(
      rejected[1]?.code,
      "BAD_REQUEST",
      "Oversized batches fail before opening a metadata transaction",
    );
    const read = async (includeDomains: boolean) => {
      const first = await required(
        owner.query(
          "zerotrust.access.snapshot",
          { includeDomains },
          { strategy: "network-only" },
        ),
      );
      const domains = [...first.domains];
      const origins = [...first.origins];
      assert.ok(first.domains.length <= 64);
      assert.ok(first.origins.length <= 64);
      let page: Pick<
        QueryResult<"zerotrust.access.page">,
        "snapshot" | "after"
      > = first;
      let count = 1;
      assert.ok(page.after, "The inventory must span more than one page");
      while (page.after !== null) {
        const next: QueryResult<"zerotrust.access.page"> = await required(
          owner.query(
            "zerotrust.access.page",
            {
              snapshot: first.snapshot,
              after: page.after,
              includeDomains,
            },
            { strategy: "network-only" },
          ),
        );
        assert.equal(next.snapshot, first.snapshot);
        assert.ok(next.domains.length <= 64);
        assert.ok(next.origins.length <= 64);
        domains.push(...next.domains);
        origins.push(...next.origins);
        page = next;
        count++;
      }
      assert.ok(count >= 3);
      assert.equal(
        new Set(domains.map((area) => area.id)).size,
        domains.length,
      );
      assert.equal(
        new Set(origins.map((origin) => origin.id)).size,
        origins.length,
      );
      return { first, domains, origins };
    };
    const complete = await read(true);
    const revalidate = () =>
      required(
        owner.query(
          "zerotrust.access.snapshot",
          {
            known: complete.first.snapshot,
          },
          { strategy: "network-only" },
        ),
      );
    const unchanged = await revalidate();
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.domains, []);
    assert.deepEqual(unchanged.origins, []);
    assert.equal(unchanged.after, null);
    assert.ok(complete.origins.length >= 130);
    assert.deepEqual(
      complete.domains,
      await required(
        peer.query("zerotrust.domains.list", undefined, {
          strategy: "network-only",
        }),
      ),
    );
    assert.deepEqual(
      complete.origins,
      await required(
        peer.query("zerotrust.creations.list", undefined, {
          strategy: "network-only",
        }),
      ),
    );
    const menu = await read(false);
    assert.deepEqual(menu.domains, []);
    assert.deepEqual(menu.origins, complete.origins);
    const verified = await verifiedAccessContext(owner, signal);
    for (const area of areas)
      assert.equal(
        allows(verified.permissions, {
          tenant: context.account.tenant,
          version: verified.permissions.version,
          subjects: [subject],
          scope: area.scope,
          facet: area.facet,
          action: "read",
        }),
        true,
      );

    async function continuePage(
      snapshot: string,
      includeDomains = true,
      client = owner,
    ) {
      return client.query(
        "zerotrust.access.page",
        {
          snapshot,
          after: complete.first.after!,
          includeDomains,
        },
        { strategy: "network-only" },
      );
    }
    for (const result of [
      await continuePage(base64(new Uint8Array(32))),
      await continuePage(complete.first.snapshot, false),
      await continuePage(complete.first.snapshot, true, peer),
    ]) {
      assert.equal(result[0], null);
      assert.equal(
        result[1]?.code,
        "CONFLICT",
        "Snapshots are bound to session and request context",
      );
    }

    // Concurrent business writes must not invalidate a public access inventory.
    const collection = await protectedCollection(peer, areas[0]!, signal);
    try {
      await collection.read();
      await collection.write([
        await collection.packet(areas[0]!.prefix, {
          private: "Private page inventory fixture 861329",
        }),
      ]);
    } finally {
      collection.close();
    }
    assert.equal((await continuePage(complete.first.snapshot))[1], null);
    assert.equal(
      (await revalidate()).unchanged,
      true,
      "Business writes preserve the conditional inventory",
    );

    // Grants and policy publications are structural, unlike object revisions.
    const definition = await required(
      peer.query(
        "zerotrust.domains.get",
        {
          domain: areas[0]!.domain,
          generation: "1",
        },
        { strategy: "network-only" },
      ),
    );
    const box = await required(
      peer.query(
        "zerotrust.keys.get",
        {
          domain: definition.id,
          generation: definition.generation,
        },
        { strategy: "network-only" },
      ),
    );
    const verifiedDefinition = await verifyDomain(
      definition,
      {
        tenant: context.account.tenant,
        id: definition.id,
        scope: definition.scope,
        facet: definition.facet,
        generation: definition.generation,
      },
      context.history.authority,
    );
    const raw = await openBox(
      box,
      {
        tenant: context.account.tenant,
        purpose: "area-key",
        object: definition.id,
        generation: definition.generation,
        recipient: subject,
        author: box.author,
      },
      context.account.identity.encryptionKey.privateKey,
      await domainBoxSigner(verifiedDefinition, box, context.history.authority),
    );
    try {
      const envelope = await sealBox(
        {
          tenant: context.account.tenant,
          purpose: "area-key",
          object: definition.id,
          generation: definition.generation,
          recipient: subject,
          author: `authority:${context.history.current.generation}`,
        },
        raw,
        context.account.identity.encryptionKey.publicKey,
        context.authority,
      );
      await required(
        peer.mutate("zerotrust.keys.grant", {
          domain: definition.id,
          generation: definition.generation,
          envelope,
        }),
      );
    } finally {
      raw.fill(0);
    }
    assert.equal(
      (await revalidate()).unchanged,
      true,
      "An equivalent recipient envelope does not change the inventory",
    );

    // A valid recovery-only generation advertises a pending rotation. Adding
    // its missing ordinary reader changes that flag and must invalidate pages.
    const made = await createDomain({
      tenant: context.account.tenant,
      id: definition.id,
      scope: definition.scope,
      facet: definition.facet,
      generation: "2",
      policyVersion: verified.rootPolicy.version,
      authorityGeneration: context.history.current.generation,
      authorityKey: context.authority,
      recovery: {
        encryptionKey: context.history.current.recoveryEncryptionKey,
        signingKey: context.history.current.recoverySigningKey,
      },
      readers: [
        { subject, identity: await publicIdentity(context.account.identity) },
      ],
    });
    const recoveryOnly = { ...made.definition, envelopes: [] };
    recoveryOnly.proof = await sign(
      context.authority,
      await domainFrame(recoveryOnly),
    );
    await required(peer.mutate("zerotrust.domains.put", recoveryOnly));
    const beforeGrant = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {},
        { strategy: "network-only" },
      ),
    );
    assert.equal(
      (
        await required(
          owner.query(
            "zerotrust.access.snapshot",
            { domain: definition.id },
            { strategy: "network-only" },
          ),
        )
      ).domains[0]?.rotationRequired,
      true,
    );
    await required(
      peer.mutate("zerotrust.keys.grant", {
        domain: definition.id,
        generation: "2",
        envelope: made.definition.envelopes[0]!,
      }),
    );
    assert.equal(
      (await continuePage(beforeGrant.snapshot))[1]?.code,
      "CONFLICT",
    );
    assert.equal(
      (
        await required(
          owner.query(
            "zerotrust.access.snapshot",
            { domain: definition.id },
            { strategy: "network-only" },
          ),
        )
      ).domains[0]?.rotationRequired,
      false,
    );
    const changed = await revalidate();
    assert.equal(
      changed.unchanged,
      false,
      "Key grants cannot reuse an old verified inventory",
    );
    assert.notEqual(changed.snapshot, complete.first.snapshot);
    const stableMenu = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {
          includeDomains: false,
          known: menu.first.snapshot,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(
      stableMenu.unchanged,
      true,
      "Key rotations do not change the certified origin inventory used by menus",
    );
    const beforePolicy = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {},
        { strategy: "network-only" },
      ),
    );
    const { permissions } = await readVerifiedPolicy(owner, context);
    await publishVerifiedPolicy(peer, context, {
      ...permissions,
      version: (BigInt(permissions.version) + 1n).toString(),
    });
    assert.equal(
      (await continuePage(beforePolicy.snapshot))[1]?.code,
      "CONFLICT",
    );
    const menuAfterPolicy = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {
          includeDomains: false,
          known: menu.first.snapshot,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(
      menuAfterPolicy.unchanged,
      false,
      "Policy changes still invalidate menu proofs",
    );
    const beforeRegistration = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {},
        { strategy: "network-only" },
      ),
    );
    await createResourceAreas(peer, [makeArea()], "tool", signal);
    assert.equal(
      (await continuePage(beforeRegistration.snapshot))[1]?.code,
      "CONFLICT",
    );
    const menuAfterOrigin = await required(
      owner.query(
        "zerotrust.access.snapshot",
        {
          includeDomains: false,
          known: menuAfterPolicy.snapshot,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(
      menuAfterOrigin.unchanged,
      false,
      "A new certified origin cannot reuse a stale menu inventory",
    );
    const selected = await required(
      owner.query(
        "zerotrust.access.snapshot",
        { domain: areas[0]!.domain },
        { strategy: "network-only" },
      ),
    );
    assert.equal(selected.after, null);
    assert.equal(selected.domains.length, 1);
    assert.ok(routed >= 10);
    console.log(
      "Native access pages: 130 certified origins across two API instances; content saves and equivalent key grants preserve snapshots; changed rotation state, policy and registration invalidate them; wrong session and request context are rejected",
    );
  } finally {
    setRequestHook(null);
  }
}
