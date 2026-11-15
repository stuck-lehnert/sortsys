import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  bytes,
  encryptObject,
  signPolicy,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { openAuthority } from "../app/lib/crypto/setup";
import { signIn, trustedHistory } from "../app/lib/crypto/session";
import { watchEncryptedEvents } from "../app/lib/data/events";
import type { EncryptedChange } from "../app/lib/data/events";

async function required<T>(response: Promise<[T | null, Error | null]>) {
  const [value, error] = await response;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Real browser transport over independently authenticated API peers. */
export async function exerciseNativeEvents(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  key: CryptoKey,
) {
  const endpoints: string[] = JSON.parse(
    process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
  );
  for (const endpoint of endpoints)
    assert.equal(new URL(endpoint).hostname, "127.0.0.1");
  const subject = `user:${draft.userId}`;
  const scope = "project:abc";
  const domain = `${scope}:master-data`;
  const authority = await openAuthority(owner, draft.setup);
  const history = await trustedHistory(owner);
  const original = await verifyPolicy(
    await required(owner.query("zerotrust.policy.get", undefined)),
    {
      tenant: draft.link.tenant,
      authority: history.authority("1"),
    },
  );
  let policyVersion = original.permissions.version;
  const streams = [
    { client: owner, endpoint: endpoints[0]! },
    { client: peer, endpoint: endpoints[1]! },
    { client: peer, endpoint: endpoints[1]! },
  ].map((source) => ({
    ...source,
    controller: new AbortController(),
    changes: [] as EncryptedChange[],
  }));
  const running = streams.map((stream) =>
    watchEncryptedEvents(
      stream.client,
      stream.endpoint,
      (change) => {
        stream.changes.push(change);
      },
      stream.controller.signal,
    ),
  );
  async function write(object: string) {
    return required(
      owner.mutate("zerotrust.objects.save", {
        domain,
        messageId: crypto.randomUUID(),
        envelope: await encryptObject(
          {
            tenant: draft.link.tenant,
            scope,
            facet: "master-data",
            object,
            revision: "1",
            generation: "1",
            policyVersion,
            author: subject,
          },
          bytes("Private content must not enter notification frames"),
          key,
          draft.identity.signingKey.privateKey,
        ),
      }),
    );
  }
  try {
    await waitFor(
      () => streams.every((stream) => stream.changes.length > 0),
      "Every socket reaches its authenticated baseline",
    );
    for (const stream of streams) stream.changes.length = 0;
    await write("note:native-event-first");
    await waitFor(
      () =>
        streams.every((stream) =>
          stream.changes.some(
            (change) => typeof change.domains[domain] === "string",
          ),
        ),
      "An object committed through the first API reaches sockets on both APIs",
    );
    for (const stream of streams) {
      assert.ok(!JSON.stringify(stream.changes).includes("Private content"));
      stream.changes.length = 0;
    }
    policyVersion = (BigInt(policyVersion) + 1n).toString();
    await required(
      owner.mutate(
        "zerotrust.policy.replace",
        await signPolicy(
          {
            ...original.permissions,
            version: policyVersion,
            rules: [
              ...original.permissions.rules,
              {
                subject,
                scope,
                facet: "master-data",
                actions: ["read"],
                effect: "deny",
              },
            ],
          },
          authority,
        ),
      ),
    );
    await waitFor(
      () =>
        streams.every((stream) =>
          stream.changes.some((change) => change.reset),
        ),
      "Removing a read right invalidates all connected clients without waiting for heartbeat",
    );
    await assert.rejects(() => write("note:native-event-denied"));
    for (const stream of streams) stream.changes.length = 0;
    policyVersion = (BigInt(policyVersion) + 1n).toString();
    await required(
      owner.mutate(
        "zerotrust.policy.replace",
        await signPolicy(
          { ...original.permissions, version: policyVersion },
          authority,
        ),
      ),
    );
    await waitFor(
      () =>
        streams.every((stream) =>
          stream.changes.some((change) => change.control),
        ),
      "Restoring a right refreshes the subscribed scopes",
    );
    await write("note:native-event-restored");
    await waitFor(
      () =>
        streams.every((stream) =>
          stream.changes.some(
            (change) => typeof change.domains[domain] === "string",
          ),
        ),
      "Subscriptions resume with the new access snapshot",
    );
    const [, error] = await peer.mutate("auth.logout", undefined);
    assert.equal(error, null);
    await waitFor(
      () => !peer.loggedIn(),
      "A session closed on one API revokes sockets on the other transport",
    );
    assert.equal(
      owner.loggedIn(),
      true,
      "A distinct owner session remains usable",
    );
  } finally {
    for (const stream of streams) stream.controller.abort();
    await Promise.all(running);
  }
  await signIn(peer, {
    tenant: draft.link.tenant,
    username: "builder",
    password: draft.password,
  });
  console.log(
    "Native events: two API hubs, three browser sockets, committed object hints, permission loss/restoration and session revocation verified.",
  );
}
