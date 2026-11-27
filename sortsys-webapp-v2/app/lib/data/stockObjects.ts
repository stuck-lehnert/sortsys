import type { Client, QueryInput } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  record,
  signStockDeletion,
  signStockReferences,
  stockBinding,
  stockDeletion,
  stockDeletionFrame,
  stockKind,
  stockReferenceFrame,
  stockReferences,
  verify,
  verifyStockDeletion,
  verifyStockReferences,
  objectPacketHash,
} from "@sortsys/zerotrust/sortsys";
import type {
  EncryptedObject,
  StockDeletion,
  StockReferences,
} from "@sortsys/zerotrust/sortsys";
import type { trustedHistory, UnlockedAccount } from "../crypto/session";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { mapConcurrent } from "./runtime/concurrentReads";

type History = Awaited<ReturnType<typeof trustedHistory>>;
type ProofSigner = History["proofSigner"];
export type StockState = {
  references: StockReferences;
  vendorDeletion: StockDeletion | null;
};
type Opened = { envelope: EncryptedObject; value: unknown; stock?: StockState };
const required = async <T>(response: Promise<[T | null, Error | null]>) => {
  const [value, error] = await response;
  if (error) throw error;
  if (value === null) throw new InvalidProtectedData();
  return value;
};
function id(input: unknown) {
  if (
    typeof input !== "string" ||
    !/^[1-9]\d*$/.test(input) ||
    BigInt(input) > 9223372036854775807n
  )
    throw new InvalidProtectedData();
  return BigInt(input).toString(32);
}
/** Compare signed public relationships with the actual decrypted row. Public
 * metadata may not silently redirect an encrypted price to a different item. */
export function stockReferenceData(
  object: string,
  value: unknown,
): { product: string | null; vendor: string | null } {
  const kind = stockKind(object);
  if (!kind) throw new InvalidProtectedData();
  const key =
    kind === "price" ? "price" : kind === "vendor" ? "vendor" : "product";
  const data = record(
    value,
    kind === "product" ? ["format", key, "categories"] : ["format", key],
  );
  if (data.format !== `sortsys-${kind === "price" ? "product-price" : kind}-v1`)
    throw new InvalidProtectedData();
  const row = decodeBusinessRow(data[key]);
  if (
    row.table !==
      (kind === "price"
        ? "product_price_records"
        : kind === "vendor"
          ? "product_vendors"
          : "products") ||
    object !==
      `${kind === "price" ? "product-price" : kind}:${id(row.values.id)}`
  )
    throw new InvalidProtectedData();
  return kind === "price"
    ? {
        product: `product:${id(row.values.product_id)}`,
        vendor:
          row.values.vendor_id === null
            ? null
            : `vendor:${id(row.values.vendor_id)}`,
      }
    : { product: null, vendor: null };
}
export async function stockPacket(
  envelope: EncryptedObject,
  value: unknown,
  generation: string,
  signingKey: CryptoKey,
) {
  return signStockReferences(
    {
      ...stockBinding(envelope, generation, await objectPacketHash(envelope)),
      ...stockReferenceData(envelope.object, value),
    },
    signingKey,
  );
}
async function deletionProof(
  input: unknown,
  history: History,
  tenant: string,
  key: ProofSigner = history.proofSigner,
) {
  const deletion = stockDeletion(input);
  if (deletion.tenant !== tenant) throw new InvalidProtectedData();
  return verifyStockDeletion(
    deletion,
    await key(
      deletion.author,
      deletion.authorityGeneration,
      deletion.signature,
      stockDeletionFrame(deletion),
    ),
  );
}
export async function checkStockObjects(
  client: Client,
  objects: Opened[],
  history: History,
  live: () => void,
  prepared?: QueryInput<"zerotrust.stock.references">["prepared"],
) {
  const selected = objects.filter((object) =>
    stockKind(object.envelope.object),
  );
  const signingKeys = new Map<string, Promise<CryptoKey>>(),
    checked: { object: Opened; state: StockState }[] = [];
  const signingKey: ProofSigner = (author, generation, signature, message) => {
    const id = JSON.stringify([author, generation, signature]);
    let key = signingKeys.get(id);
    if (!key) {
      key = history.proofSigner(author, generation, signature, message);
      signingKeys.set(id, key);
    }
    return key;
  };
  // Four independent metadata reads can share one HTTP batch. Keep the next
  // window bounded, and retain the existing limit of 16 cryptographic checks
  // across the entire window rather than multiplying it by the read count.
  for (let offset = 0; offset < selected.length; offset += 256) {
    const window = selected.slice(offset, offset + 256);
    const chunks: Opened[][] = [];
    for (let start = 0; start < window.length; start += 64) {
      chunks.push(window.slice(start, start + 64));
    }
    const responses = await mapConcurrent(chunks, 4, async (chunk) => {
      live();
      const states = await required(
        client.query(
          "zerotrust.stock.references",
          {
            objects: chunk.map((object) => object.envelope.object),
            ...(prepared ? { prepared } : {}),
          },
          { strategy: "network-only" },
        ),
      );
      live();
      if (
        states.length !== chunk.length ||
        new Set(states.map((state) => state.object)).size !== chunk.length
      ) {
        throw new InvalidProtectedData();
      }
      const byId = new Map(states.map((state) => [state.object, state]));
      return chunk.map((object) => {
        const state = byId.get(object.envelope.object);
        if (!state) throw new InvalidProtectedData();
        return { object, state };
      });
    });
    const verified = await mapConcurrent(
      responses.flat(),
      16,
      async ({ object, state }) => {
        live();
        const raw = stockReferences(state.references);
        const references = await verifyStockReferences(
          raw,
          object.envelope,
          await signingKey(
            raw.author,
            raw.authorityGeneration,
            raw.signature,
            stockReferenceFrame(raw),
          ),
        );
        live();
        const actual = stockReferenceData(object.envelope.object, object.value);
        if (
          actual.product !== references.product ||
          actual.vendor !== references.vendor
        )
          throw new InvalidProtectedData();
        const vendorDeletion =
          state.vendorDeletion === null
            ? null
            : await deletionProof(
                state.vendorDeletion,
                history,
                references.tenant,
                signingKey,
              );
        live();
        if (
          vendorDeletion &&
          (references.kind !== "price" ||
            vendorDeletion.kind !== "vendor" ||
            vendorDeletion.object !== references.vendor)
        )
          throw new InvalidProtectedData();
        return { object, state: { references, vendorDeletion } };
      },
    );
    checked.push(...verified);
  }
  live();
  for (const { object, state } of checked) object.stock = state;
}
export function effectivePrice(object: Opened): BusinessRow {
  const data = record(object.value, ["format", "price"]),
    price = decodeBusinessRow(data.price);
  if (
    !object.stock ||
    data.format !== "sortsys-product-price-v1" ||
    price.table !== "product_price_records"
  )
    throw new InvalidProtectedData();
  return object.stock.vendorDeletion
    ? { ...price, values: { ...price.values, vendor_id: null } }
    : price;
}
export async function deleteStockObject(
  client: Client,
  account: UnlockedAccount,
  history: History,
  subject: string,
  policyVersion: string,
  object: string,
  previous: EncryptedObject | undefined,
  live: () => void,
): Promise<void> {
  const kind = stockKind(object);
  if (!kind) throw new InvalidProtectedData();
  const check = async (expected?: StockDeletion) => {
    const [state, error] = await client.query(
      "zerotrust.stock.deleted",
      { object },
      { strategy: "network-only" },
    );
    live();
    if (error) throw error;
    if (!state) return false;
    const proof = await deletionProof(state.deletion, history, account.tenant);
    live();
    const reference = stockReferences(state.references);
    const key = await history.proofSigner(
      reference.author,
      reference.authorityGeneration,
      reference.signature,
      stockReferenceFrame(reference),
    );
    // The declaration itself is signed even when its ciphertext is no longer
    // visible. Binding is checked against the caller's envelope when present.
    await verify(key, reference.signature, stockReferenceFrame(reference));
    live();
    if (
      state.object !== object ||
      reference.object !== object ||
      reference.tenant !== account.tenant ||
      (proof.object !== object &&
        !(
          kind === "price" &&
          proof.kind === "product" &&
          reference.product === proof.object
        )) ||
      (expected && proof.signature !== expected.signature) ||
      (previous &&
        (reference.revision !== previous.revision ||
          reference.envelopeHash !== (await objectPacketHash(previous)))) ||
      (proof.object === object &&
        (proof.revision !== reference.revision ||
          proof.envelopeHash !== reference.envelopeHash))
    )
      throw new InvalidProtectedData();
    live();
    return true;
  };
  if (!previous) {
    if (await check()) return;
    throw new InvalidProtectedData();
  }
  const proof = await signStockDeletion(
    {
      ...stockBinding(
        previous,
        history.current.generation,
        await objectPacketHash(previous),
      ),
      author: subject,
      policyVersion,
    },
    account.identity.signingKey.privateKey,
  );
  live();
  const [, error] = await client.mutate("zerotrust.stock.delete", proof);
  live();
  if (!(await check(proof))) throw error ?? new InvalidProtectedData();
}
