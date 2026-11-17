import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  protectedCollections,
  required,
  type Collection,
} from "../app/lib/data/protectedObjects";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";

export async function exerciseRpcBatching(
  client: Client,
  transmissions: readonly string[][],
) {
  const session = await required(client.query("auth.sessionInfo", undefined));
  const start = transmissions.length;
  const pending = [];
  for (let index = 0; index < 40; index++) {
    pending.push(
      required(
        client.query(
          "zerotrust.access.snapshot",
          { domains: [`testing:batch${index}:master-data`] },
          { strategy: "network-only" },
        ),
      ),
    );
    // Each request reaches the transport in a separate microtask. They have
    // different inputs, so request deduplication cannot explain the reduction.
    await Promise.resolve();
  }
  const snapshots = await Promise.all(pending);
  assert.equal(snapshots.length, 40);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.subject, `user:${session.user.id}`);
    assert.equal(snapshot.username, session.user.username);
    assert.deepEqual(snapshot.domains, []);
  }
  assert.deepEqual(
    transmissions.slice(start).map((paths) => paths.length),
    [32, 8],
  );
  assert.equal(
    transmissions
      .slice(start)
      .flat()
      .every((path) => path === "zerotrust.access.snapshot"),
    true,
  );
  console.log(
    "Native RPC batching: 40 distinct authenticated reads use 2 HTTP requests with every result preserved",
  );
}

export async function exerciseBatchedReads(
  client: Client,
  peer: Client,
  area: Collection,
  snapshot: string,
  signal: AbortSignal,
) {
  const access = await required(peer.query("zerotrust.access.snapshot", {}));
  const [history, policy, origins, domains, session] = await Promise.all([
    required(peer.query("zerotrust.trust.history", undefined)),
    required(peer.query("zerotrust.policy.get", undefined)),
    required(peer.query("zerotrust.creations.list", undefined)),
    required(peer.query("zerotrust.domains.list", undefined)),
    required(peer.query("auth.sessionInfo", undefined)),
  ]);
  assert.deepEqual(access.history, history);
  assert.deepEqual(access.policy, policy);
  assert.deepEqual(access.origins, origins);
  assert.deepEqual(access.domains, domains);
  assert.equal(access.subject, `user:${session.user.id}`);
  assert.equal(access.username, session.user.username);
  const narrowAccess = await required(
    peer.query("zerotrust.access.snapshot", { domain: area.domain }),
  );
  assert.deepEqual(
    narrowAccess.domains,
    domains.filter((domain) => domain.id === area.domain),
  );
  const menuAccess = await required(
    peer.query("zerotrust.access.snapshot", { includeDomains: false }),
  );
  assert.deepEqual(menuAccess.domains, []);
  assert.deepEqual(menuAccess.policy, policy);
  const selectedDomains = [area.domain, "testing:missing:master-data"];
  const selectedAccess = await required(
    peer.query("zerotrust.access.snapshot", { domains: selectedDomains }),
  );
  assert.deepEqual(selectedAccess.domains, narrowAccess.domains);
  assert.deepEqual(selectedAccess.origins, narrowAccess.origins);
  const selected = await protectedCollections(client, signal, selectedDomains);
  assert.equal(selected.readable(area), true);
  for (const input of [
    { domains: [] },
    { domains: [area.domain, area.domain] },
    {
      domains: Array.from(
        { length: 17 },
        (_, index) => `testing:missing${index}:master-data`,
      ),
    },
    { domain: area.domain, domains: [area.domain] },
  ]) {
    const [value, error] = await peer.query("zerotrust.access.snapshot", input);
    assert.equal(value, null);
    assert.ok(error);
  }
  for (const substitute of ["subject", "policy", "history"] as const) {
    let keysRequested = false;
    const observed: Client = {
      ...client,
      query: (async (path, input, options) => {
        if (path === "zerotrust.keys.get") keysRequested = true;
        const reply = await client.query(path, input, options);
        if (path !== "zerotrust.access.snapshot" || reply[1] || !reply[0])
          return reply;
        const forged = structuredClone(
          reply[0] as QueryResult<"zerotrust.access.snapshot">,
        );
        if (substitute === "subject") forged.subject += ":substituted";
        if (substitute === "policy")
          forged.policy.version = (
            BigInt(forged.policy.version) + 1n
          ).toString();
        if (substitute === "history")
          forged.history.authorities[0]!.certificate.generation = "999";
        return [forged, null];
      }) as Client["query"],
    };
    await assert.rejects(
      protectedCollections(observed, signal),
      `A substituted ${substitute} must be rejected before requesting keys`,
    );
    assert.equal(keysRequested, false);
  }
  // Login names can change and are not part of a vault's identity binding.
  // An untrusted display alias must not choose another principal or policy.
  const originalContext = await verifiedAccessContext(client, signal);
  const changedAlias: Client = {
    ...client,
    query: (async (path, input, options) => {
      const reply = await client.query(path, input, options);
      if (path !== "zerotrust.access.snapshot" || reply[1] || !reply[0])
        return reply;
      const changed = structuredClone(
        reply[0] as QueryResult<"zerotrust.access.snapshot">,
      );
      changed.username = "another.login.name";
      return [changed, null];
    }) as Client["query"],
  };
  const aliasContext = await verifiedAccessContext(changedAlias, signal);
  assert.equal(aliasContext.account, originalContext.account);
  assert.equal(aliasContext.subject, originalContext.subject);
  assert.deepEqual(aliasContext.permissions, originalContext.permissions);
  assert.deepEqual(
    aliasContext.history.identityCertificate(aliasContext.subject),
    originalContext.history.identityCertificate(originalContext.subject),
  );
  const first = {
    domain: area.domain,
    prefix: "staged:0",
    after: null,
    snapshot,
    includeOpenings: true,
  };
  const second = { ...first, prefix: "staged:1" };
  const pages = await required(
    peer.query("zerotrust.objects.pages", {
      selections: [first, second],
    }),
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.objects.length, 1);
  assert.equal(pages[1]!.objects.length, 32);
  assert.ok(pages[1]!.after);
  for (const page of pages) {
    assert.equal(page.snapshot, snapshot);
    assert.equal(page.openings?.length, 1);
    assert.equal(page.openings[0]!.definition.id, area.domain);
  }

  const head = await required(
    peer.query("zerotrust.objects.pages", {
      selections: [{ ...first, headOnly: true }],
    }),
  );
  assert.equal(head[0]!.snapshot, snapshot);
  assert.deepEqual(head[0]!.objects, []);
  assert.equal(head[0]!.openings, undefined);
  const [partial, raced] = await peer.query("zerotrust.objects.pages", {
    selections: [
      first,
      { ...second, snapshot: (BigInt(snapshot) + 1n).toString() },
    ],
  });
  assert.equal(partial, null);
  assert.equal(raced?.code, "CONFLICT");
  for (const selections of [
    [],
    Array.from({ length: 17 }, () => first),
    [{ ...first, headOnly: true, snapshot: null }],
  ]) {
    const [value, error] = await peer.query("zerotrust.objects.pages", {
      selections,
    });
    assert.equal(value, null);
    assert.ok(error);
  }

  const trusted = await protectedCollections(client, signal);
  await trusted.prefetch([{ area }]);
  const collection = trusted(area);
  try {
    assert.equal((await collection.read()).length, 320);
  } finally {
    collection.close();
  }

  for (const substitute of ["definition", "recipient"] as const) {
    let alterOpening = false;
    const observed: Client = {
      ...client,
      query: (async (path, input, options) => {
        const reply = await client.query(path, input, options);
        if (
          !alterOpening ||
          path !== "zerotrust.objects.pages" ||
          reply[1] ||
          reply[0] === null
        )
          return reply;
        const changed = structuredClone(
          reply[0] as QueryResult<"zerotrust.objects.pages">,
        );
        const opening = changed[0]?.openings?.[0];
        assert.ok(
          opening,
          "The test must alter an opening that the reader uses",
        );
        if (substitute === "definition") {
          opening.definition.id = "testing:substituted:master-data";
        } else {
          opening.envelope.recipient += ":substituted";
        }
        return [changed, null];
      }) as Client["query"],
    };
    const primed = await protectedCollections(observed, signal);
    const narrow = { ...area, prefix: "staged:0" };
    await primed.prefetch([{ area: narrow }]);
    const verified = primed(narrow);
    try {
      assert.equal((await verified.read()).length, 1);
    } finally {
      verified.close();
    }
    alterOpening = true;
    const untrusted = await protectedCollections(observed, signal);
    await untrusted.prefetch([{ area }]);
    const rejected = untrusted(area);
    try {
      await assert.rejects(() => rejected.read());
    } finally {
      rejected.close();
    }
  }
  console.log(
    "Native collection batches: pagination, exact snapshots, bounded requests, cached-content validation and substituted key-proof rejection verified",
  );
}
