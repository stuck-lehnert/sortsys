import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  bytes,
  createDomain,
  encryptObject,
  publicIdentity,
  signPolicy,
  signStockDeletion,
  stockBinding,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import type { Facet } from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory } from "../app/lib/crypto/session";
import {
  checkStockObjects,
  effectivePrice,
  stockEnvelopeHash,
  stockPacket,
} from "../app/lib/data/stockObjects";
import { row } from "../app/lib/data/testing/businessRow.mjs";

async function required<T>(response: Promise<[T | null, Error | null]>) {
  const [value, error] = await response;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}

/** Actual signed catalogue writes through two API peers sharing one tenant file. */
export async function exerciseStockStore(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  productKey: CryptoKey,
) {
  const tenant = draft.link.tenant;
  const author = `user:${draft.userId}`;
  const authority = await openAuthority(owner, draft.setup);
  const history = await trustedHistory(owner);
  const previous = await verifyPolicy(
    await required(owner.query("zerotrust.policy.get", undefined)),
    { tenant, authority: history.authority("1") },
  );
  const policyVersion = (BigInt(previous.permissions.version) + 1n).toString();
  const extras = [
    { scope: "catalog:products", facet: "procurement" as const },
    { scope: "catalog:vendors", facet: "master-data" as const },
  ];
  await required(
    owner.mutate(
      "zerotrust.policy.replace",
      await signPolicy(
        {
          ...previous.permissions,
          version: policyVersion,
          rules: [
            ...previous.permissions.rules,
            ...extras.map((area) => ({
              ...area,
              subject: author,
              actions: [...ACTIONS],
              effect: "allow" as const,
            })),
          ],
        },
        authority,
      ),
    ),
  );
  const keys = new Map([
    ["catalog:products:master-data", { key: productKey, generation: "2" }],
  ]);
  for (const area of extras) {
    const domain = `${area.scope}:${area.facet}`;
    const made = await createDomain({
      ...area,
      tenant,
      id: domain,
      generation: "1",
      policyVersion,
      authorityGeneration: "1",
      authorityKey: authority,
      recovery: {
        encryptionKey: history.current.recoveryEncryptionKey,
        signingKey: history.current.recoverySigningKey,
      },
      readers: [
        { subject: author, identity: await publicIdentity(draft.identity) },
      ],
    });
    await required(owner.mutate("zerotrust.domains.put", made.definition));
    keys.set(domain, { key: made.key, generation: "1" });
  }
  async function packet(object: string, value: unknown, revision = "1") {
    const scope = object.startsWith("vendor:")
      ? "catalog:vendors"
      : "catalog:products";
    const facet: Facet = object.startsWith("product-price:")
      ? "procurement"
      : "master-data";
    const domain = `${scope}:${facet}`;
    const material = keys.get(domain)!;
    const envelope = await encryptObject(
      {
        tenant,
        scope,
        facet,
        object,
        revision,
        generation: material.generation,
        policyVersion,
        author,
      },
      bytes(JSON.stringify(value)),
      material.key,
      draft.identity.signingKey.privateKey,
    );
    return {
      domain,
      messageId: crypto.randomUUID(),
      envelope,
      references: await stockPacket(
        envelope,
        value,
        "1",
        draft.identity.signingKey.privateKey,
      ),
    };
  }
  async function batch(
    client: Client,
    objects: Awaited<ReturnType<typeof packet>>[],
  ) {
    const heads = await Promise.all(
      [...keys.keys()].map(async (domain) => {
        const prefix = domain.startsWith("catalog:vendors")
          ? "vendor:"
          : domain.endsWith(":procurement")
            ? "product-price:"
            : "product:";
        const page = await required(
          client.query(
            "zerotrust.objects.list",
            {
              domain,
              prefix,
              after: null,
              snapshot: null,
            },
            { strategy: "network-only" },
          ),
        );
        return { domain, sequence: page.snapshot };
      }),
    );
    return { objects, heads };
  }
  async function publish(
    client: Client,
    objects: Awaited<ReturnType<typeof packet>>[],
  ) {
    return required(
      client.mutate("zerotrust.objects.batch", await batch(client, objects)),
    );
  }
  const priceValue = (id: string, product: string, vendor: string | null) => ({
    format: "sortsys-product-price-v1",
    price: row("product_price_records", {
      id,
      product_id: product,
      vendor_id: vendor,
      price: 123.45,
    }),
  });
  const productValue = (id: string) => ({
    format: "sortsys-product-v1",
    product: row("products", { id, name: `Produkt ${id}` }),
    categories: [],
  });
  const vendor = await packet("vendor:9", {
    format: "sortsys-vendor-v1",
    vendor: row("product_vendors", { id: "9", name: "Testlieferant" }),
  });
  const product = await packet("product:a", productValue("10"));
  const otherProduct = await packet("product:b", productValue("11"));
  const price = await packet("product-price:c", priceValue("12", "10", "9"));
  const secondPrice = await packet(
    "product-price:d",
    priceValue("13", "10", null),
  );
  await publish(owner, [vendor, product, otherProduct, price, secondPrice]);
  async function listed(client: Client, snapshot: string | null = null) {
    return required(
      client.query(
        "zerotrust.objects.list",
        {
          domain: "catalog:products:procurement",
          prefix: "product-price:",
          after: null,
          snapshot,
        },
        { strategy: "network-only" },
      ),
    );
  }
  assert.equal((await listed(peer)).objects.length, 2);
  const opened = {
    envelope: price.envelope,
    value: priceValue("12", "10", "9"),
  };
  await checkStockObjects(peer, [opened], history, () => {});
  assert.equal(effectivePrice(opened).values.vendor_id, "9");

  const missingParent = await packet(
    "product-price:e",
    priceValue("14", "999", null),
  );
  await assert.rejects(() => publish(peer, [missingParent]));
  assert.equal(
    (await listed(owner)).objects.length,
    2,
    "Invalid references publish no orphan price",
  );
  const deletion = async (input: typeof product) =>
    signStockDeletion(
      stockBinding(
        input.envelope,
        "1",
        await stockEnvelopeHash(input.envelope),
      ),
      draft.identity.signingKey.privateKey,
    );
  const vendorDeletion = await deletion(vendor);
  const beforeVendor = await listed(owner);
  await required(peer.mutate("zerotrust.stock.delete", vendorDeletion));
  await required(owner.mutate("zerotrust.stock.delete", vendorDeletion));
  assert.equal((await listed(owner)).objects.length, 2);
  assert.notEqual((await listed(owner)).snapshot, beforeVendor.snapshot);
  await checkStockObjects(owner, [opened], history, () => {});
  assert.equal(effectivePrice(opened).values.vendor_id, null);
  assert.equal(effectivePrice(opened).values.price, 123.45);
  const removedVendor = await packet(
    "product-price:e",
    priceValue("14", "10", "9"),
  );
  await assert.rejects(() => publish(owner, [removedVendor]));
  const detached = await packet(
    "product-price:c",
    priceValue("12", "10", null),
    "2",
  );
  await publish(owner, [detached]);

  const productDeletion = await deletion(product);
  const beforeProduct = await listed(peer);
  await required(owner.mutate("zerotrust.stock.delete", productDeletion));
  assert.notEqual((await listed(peer)).snapshot, beforeProduct.snapshot);
  assert.deepEqual((await listed(peer)).objects, []);
  for (const object of [product, detached, secondPrice]) {
    await assert.rejects(() =>
      required(
        peer.query("zerotrust.objects.get", { id: object.envelope.object }),
      ),
    );
  }
  const inherited = await required(
    peer.query("zerotrust.stock.deleted", { object: "product-price:c" }),
  );
  assert.equal(inherited.deletion.signature, productDeletion.signature);
  assert.equal(inherited.references.revision, "2");
  await assert.rejects(() =>
    required(
      peer.query("zerotrust.stock.references", {
        objects: ["product-price:c"],
      }),
    ),
  );
  const recreated = await packet("product:a", productValue("10"), "2");
  await assert.rejects(() => publish(owner, [recreated]));
  const deadParent = await packet(
    "product-price:e",
    priceValue("14", "10", null),
  );
  await assert.rejects(() => publish(owner, [deadParent]));

  const concurrentPrice = await packet(
    "product-price:f",
    priceValue("15", "11", null),
  );
  const otherDeletion = await deletion(otherProduct);
  const prepared = await batch(owner, [concurrentPrice]);
  const [writeResult, deleteResult] = await Promise.all([
    owner.mutate("zerotrust.objects.batch", prepared),
    peer.mutate("zerotrust.stock.delete", otherDeletion),
  ]);
  assert.ok(
    !writeResult[1] || !deleteResult[1],
    "A competing publication or deletion succeeds",
  );
  if (deleteResult[1])
    await required(peer.mutate("zerotrust.stock.delete", otherDeletion));
  assert.deepEqual((await listed(owner)).objects, []);
  await assert.rejects(() =>
    required(owner.query("zerotrust.objects.get", { id: "product-price:f" })),
  );
  await required(owner.mutate("zerotrust.stock.delete", productDeletion));
  console.log(
    "Native catalogue: signed references, vendor context, product cascade and concurrent deletion verified.",
  );
}
