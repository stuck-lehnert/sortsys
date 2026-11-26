import { expect, test } from "bun:test";
import {
  areaKey,
  attestMigrationOrigin,
  bytes,
  createIdentity,
  encryptObject,
} from "@sortsys/zerotrust/sortsys";
import { verifyActivityCopies } from "./verifyActivityCopies";

async function signedCopies(count) {
  const author = await createIdentity();
  const authority = await createIdentity();
  const key = await areaKey();

  const entries = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const source = String(index + 1);
      const scope = `personnel:${source}`;
      const facet = "master-data";
      const domain = `${scope}:${facet}`;
      const id = `legacy-activity:${domain}:${source}:event`;
      const occurredMicros = "1794484800000123";

      const envelope = await encryptObject(
        {
          tenant: "test",
          scope,
          facet,
          object: id,
          revision: "1",
          generation: "1",
          policyVersion: "1",
          author: "user:1",
        },
        bytes("original activity"),
        key,
        author.signingKey.privateKey,
      );
      const migrationOrigin = await attestMigrationOrigin(
        envelope,
        "1",
        authority.signingKey.privateKey,
        { source, occurredMicros },
      );

      return {
        copy: { domain, item: { id, source, occurredMicros } },
        stored: { domain, envelope, migrationOrigin, occurredMicros },
      };
    }),
  );

  return {
    entries,
    trusted: (generation) => {
      expect(generation).toBe("1");
      return authority.signingKey.publicKey;
    },
  };
}

test("activity verification fills a bounded queue across separate areas", async () => {
  const { entries, trusted } = await signedCopies(33);
  const replies = new Map(
    entries.map(({ stored }) => [stored.envelope.object, stored]),
  );
  const copies = entries.map(({ copy }) => copy);
  const requested = [];
  let pending = 0;
  let peak = 0;

  const client = {
    async query(path, { id, revision }, options) {
      expect(path).toBe("zerotrust.history.get");
      expect(revision).toBe("1");
      expect(options).toEqual({ strategy: "network-only" });
      requested.push(id);
      peak = Math.max(peak, ++pending);

      await Promise.resolve();

      pending--;
      return [replies.get(id), null];
    },
  };

  await verifyActivityCopies(client, copies, trusted, () => {});

  expect(peak).toBe(16);
  expect(pending).toBe(0);
  expect(requested).toEqual(copies.map(({ item }) => item.id));
});

test("the activity copy still rejects missing origins and mismatched signed evidence", async () => {
  const { entries, trusted } = await signedCopies(1);
  const [{ copy, stored }] = entries;

  for (const response of [
    { ...stored, migrationOrigin: null },
    { ...stored, domain: "personnel:999:master-data" },
    { ...stored, occurredMicros: "1794484800000124" },
  ]) {
    const client = { query: async () => [response, null] };
    await expect(
      verifyActivityCopies(client, [copy], trusted, () => {}),
    ).rejects.toThrow();
  }

  const client = { query: async () => [stored, null] };
  const wrongSource = { ...copy, item: { ...copy.item, source: "9" } };
  await expect(
    verifyActivityCopies(client, [wrongSource], trusted, () => {}),
  ).rejects.toThrow();
});

test("activity verification stops starting reads when the session ends", async () => {
  const { entries } = await signedCopies(33);
  const copies = entries.map(({ copy }) => copy);
  const replies = new Map(
    entries.map(({ stored }) => [stored.envelope.object, stored]),
  );
  const controller = new AbortController();
  const stopped = new Error("Session ended");
  let started = 0;
  let completed = 0;

  const client = {
    async query(_path, { id }) {
      started++;
      await Promise.resolve();
      controller.abort(stopped);
      completed++;
      return [replies.get(id), null];
    },
  };
  const authority = () => {
    throw new Error("A closed session may not verify a proof");
  };

  const result = verifyActivityCopies(client, copies, authority, () => {
    controller.signal.throwIfAborted();
  });

  await expect(result).rejects.toBe(stopped);
  expect(started).toBe(16);
  expect(completed).toBe(started);
});
