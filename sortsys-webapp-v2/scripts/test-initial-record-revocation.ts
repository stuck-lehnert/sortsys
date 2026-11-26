import assert from "node:assert/strict";
import { RpcClientError, type Client } from "@sortsys/v2-client";
import {
  attestMigrationOrigin,
  type CreationNamespace,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "../app/lib/data/addressBook";
import { splitCommercialRows } from "../app/lib/data/commercialData";
import { createResourceAreas } from "../app/lib/data/createProjectArea";
import { newProductRowId, publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { row } from "../app/lib/data/testing/businessRow.mjs";
import { administratorContext } from "../app/lib/crypto/administration";
import {
  readVerifiedPolicy,
  publishVerifiedPolicy,
} from "../app/lib/crypto/policy";

const NAMESPACES = ["project", "commercial", "tool", "tool-tracking"] as const;

function initialArea(namespace: CreationNamespace) {
  const scope = `${namespace}:${publicId(newProductRowId())}`;
  let object = `${scope}:master-data:record`;
  if (namespace === "project") object = scope;
  if (namespace === "commercial") object = `${scope}:master-data:case`;
  return {
    domain: `${scope}:master-data`,
    scope,
    facet: "master-data" as const,
    prefix: object,
  };
}

function initialRecord(
  namespace: CreationNamespace,
  area: ReturnType<typeof initialArea>,
  actor: string,
  title: string,
) {
  if (namespace !== "commercial") return { private: title };

  // The browser must issue a case-link attestation for this packet. Use the
  // same facet layout as a real standalone offer, not arbitrary plaintext.
  const caseId = area.scope.slice("commercial:".length);
  const date = "2026-11-08T12:30:00.123456Z";

  const payload = splitCommercialRows(caseId, [
    row("commercial_cases", {
      id: addressId(caseId),
      reference: `ANG-2026-${caseId.toUpperCase()}`,
      kind: "offer",
      status: "draft",
      title,
      existing_contract: false,
      currency: "EUR",
      scope_item_ids: "[]",
      created_by_user_id: addressId(actor),
      created_at: date,
      modified_at: date,
    }),
  ]).get("master-data");
  assert.ok(payload);
  return payload;
}

/** Exercise the public authorization boundary with valid signed ciphertext. */
export async function exerciseInitialRecordRevocation(
  owner: Client,
  peer: Client,
) {
  const signal = new AbortController().signal;
  const context = await administratorContext(owner, signal);
  const actor = context.session.user.id;
  const subject = `user:${actor}`;

  const selections = NAMESPACES.map((namespace) => ({
    namespace,
    empty: initialArea(namespace),
    established: initialArea(namespace),
  }));
  for (const selection of selections) {
    await createResourceAreas(
      owner,
      [selection.empty, selection.established],
      selection.namespace,
      signal,
    );
    const collection = await protectedCollection(
      owner,
      selection.established,
      signal,
    );
    try {
      await collection.read();
      const value = initialRecord(
        selection.namespace,
        selection.established,
        actor,
        "First authorized publication",
      );
      const packet = await collection.packet(selection.established.prefix, value);
      await collection.write([packet]);
    } finally {
      collection.close();
    }
  }
  const scopes = new Set(NAMESPACES.map((namespace) => `create:${namespace}`));
  const { permissions } = await readVerifiedPolicy(owner, context);
  const denied = await publishVerifiedPolicy(owner, context, {
    ...permissions,
    version: (BigInt(permissions.version) + 1n).toString(),
    rules: [
      ...permissions.rules,
      ...[...scopes].map((scope) => ({
        subject,
        scope,
        facet: "master-data" as const,
        actions: ["create" as const],
        effect: "deny" as const,
      })),
    ],
  });
  try {
    for (const selection of selections) {
      const collection = await protectedCollection(
        owner,
        selection.empty,
        signal,
      );
      try {
        assert.deepEqual(await collection.read(), []);
        assert.equal(
          collection.can("create"),
          true,
          "The existing area grant alone must not admit its first business record",
        );
        const value = initialRecord(
          selection.namespace,
          selection.empty,
          actor,
          "Must remain unpublished after revocation",
        );
        const packet = await collection.packet(selection.empty.prefix, value);
        const head = {
          domain: selection.empty.domain,
          sequence: collection.snapshot(),
        };
        const staged = await required(
          owner.mutate("zerotrust.objects.stage", { objects: [packet] }),
        );
        let saveFailure = "BAD_REQUEST";
        if (selection.namespace === "commercial") saveFailure = "FORBIDDEN";
        for (const attempt of [
          {
            path: "save",
            failure: saveFailure,
            run: () => peer.mutate("zerotrust.objects.save", packet),
          },
          {
            path: "batch",
            failure: "FORBIDDEN",
            run: () =>
              owner.mutate("zerotrust.objects.batch", {
                objects: [packet],
                heads: [head],
              }),
          },
          {
            path: "commit",
            failure: "FORBIDDEN",
            run: () =>
              peer.mutate("zerotrust.objects.commit", {
                parts: [staged.id],
                heads: [head],
              }),
          },
        ]) {
          const [value, error] = await attempt.run();
          assert.equal(value, null);
          assert.ok(error instanceof RpcClientError);
          assert.equal(
            error.code,
            attempt.failure,
            `${selection.namespace} ${attempt.path} must reject first publication after revocation`,
          );
          const [missing, missingError] = await peer.query(
            "zerotrust.objects.get",
            { id: selection.empty.prefix },
            { strategy: "network-only" },
          );
          assert.equal(missing, null);
          assert.equal(missingError?.code, "NOT_FOUND");
        }
        // Even a real authority signature cannot reopen backup adoption in an
        // already initialized tenant to bypass ordinary creation permission.
        const migrationOrigin = await attestMigrationOrigin(
          packet.envelope,
          context.history.current.generation,
          context.authority,
        );
        const [imported, importError] = await owner.mutate(
          "zerotrust.objects.batch",
          {
            objects: [{ ...packet, migrationOrigin }],
            heads: [head],
          },
        );
        assert.equal(imported, null);
        assert.ok(importError instanceof RpcClientError);
        assert.equal(importError.code, "FORBIDDEN");
        const [nullable, nullableError] = await owner.mutateDynamic(
          "zerotrust.objects.batch",
          {
            objects: [{ ...packet, migrationOrigin: null }],
            heads: [head],
          },
        );
        assert.equal(nullable, null);
        assert.ok(nullableError instanceof RpcClientError);
        assert.equal(nullableError.code, "FORBIDDEN");
      } finally {
        collection.close();
      }

      const existing = await protectedCollection(
        peer,
        selection.established,
        signal,
      );
      try {
        const [previous] = await existing.read();
        assert.ok(previous);

        const value = initialRecord(
          selection.namespace,
          selection.established,
          actor,
          "Existing resource remains editable",
        );
        const packet = await existing.packet(
          selection.established.prefix,
          value,
          previous.envelope,
        );
        await existing.write([packet]);

        const [updated] = await existing.read();
        assert.ok(updated);
        assert.deepEqual(updated.value, value);

        const tombstone = await existing.tombstone(
          selection.established.prefix,
          updated.envelope,
        );
        if (selection.namespace === "commercial") {
          // Only case retirement can remove the whole offer. This fixture
          // remains in the disposable tenant until teardown.
          const head = {
            domain: selection.established.domain,
            sequence: existing.snapshot(),
          };
          const [deleted, error] = await peer.mutate("zerotrust.objects.batch", {
            objects: [tombstone],
            heads: [head],
          });
          assert.equal(deleted, null);
          assert.ok(error instanceof RpcClientError);
          assert.equal(error.code, "BAD_REQUEST");

          const [retained] = await existing.read();
          assert.equal(retained?.envelope.revision, updated.envelope.revision);
        } else {
          await existing.write([tombstone]);
        }
      } finally {
        existing.close();
      }
    }
  } finally {
    const latest = (await readVerifiedPolicy(owner, context)).permissions;
    assert.equal(latest.version, denied.permissions.version);
    await publishVerifiedPolicy(owner, context, {
      ...permissions,
      version: (BigInt(latest.version) + 1n).toString(),
    });
  }
  console.log(
    "Initial publication revocation: four namespaces reject save, batch and staged commit across both API instances; existing resources remain editable",
  );
}
