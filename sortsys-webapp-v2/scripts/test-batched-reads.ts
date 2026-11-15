import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  protectedCollections,
  required,
  type Collection,
} from "../app/lib/data/protectedObjects";

export async function exerciseBatchedReads(
  client: Client,
  peer: Client,
  area: Collection,
  snapshot: string,
  signal: AbortSignal,
) {
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
