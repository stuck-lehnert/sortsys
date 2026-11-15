import type { Client } from "@sortsys/v2-client";
import {
  digest,
  importSigningKey,
  InvalidProtectedData,
  objectFrame,
  record,
  signStockDeletion,
  signStockReferences,
  signedPacketFrame,
  stockBinding,
  stockDeletion,
  stockKind,
  stockReferenceFrame,
  stockReferences,
  verify,
  verifyStockDeletion,
  verifyStockReferences,
} from "@sortsys/zerotrust/sortsys";
import type {
  EncryptedObject,
  StockDeletion,
  StockReferences,
} from "@sortsys/zerotrust/sortsys";
import type { trustedHistory, UnlockedAccount } from "../crypto/session";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";

type History = Awaited<ReturnType<typeof trustedHistory>>;
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
export const stockEnvelopeHash = (envelope: EncryptedObject) =>
  digest(signedPacketFrame(objectFrame(envelope), envelope.signature));
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
      ...stockBinding(envelope, generation, await stockEnvelopeHash(envelope)),
      ...stockReferenceData(envelope.object, value),
    },
    signingKey,
  );
}
async function deletionProof(
  input: unknown,
  history: History,
  tenant: string,
  key?: (author: string, generation: string) => Promise<CryptoKey>,
) {
  const deletion = stockDeletion(input);
  if (deletion.tenant !== tenant) throw new InvalidProtectedData();
  return verifyStockDeletion(
    deletion,
    key
      ? await key(deletion.author, deletion.authorityGeneration)
      : await importSigningKey(
          history.identityCertificate(
            deletion.author,
            deletion.authorityGeneration,
          ).signingKey,
        ),
  );
}
export async function checkStockObjects(
  client: Client,
  objects: Opened[],
  history: History,
  live: () => void,
) {
  const selected = objects.filter((object) =>
    stockKind(object.envelope.object),
  );
  const signingKeys = new Map<string, Promise<CryptoKey>>(),
    checked: { object: Opened; state: StockState }[] = [];
  const signingKey = (author: string, generation: string) => {
    const id = JSON.stringify([author, generation]);
    let key = signingKeys.get(id);
    if (!key) {
      key = importSigningKey(
        history.identityCertificate(author, generation).signingKey,
      );
      signingKeys.set(id, key);
    }
    return key;
  };
  for (let offset = 0; offset < selected.length; offset += 64) {
    const chunk = selected.slice(offset, offset + 64);
    const states = await required(
      client.query(
        "zerotrust.stock.references",
        { objects: chunk.map((object) => object.envelope.object) },
        { strategy: "network-only" },
      ),
    );
    live();
    if (
      states.length !== chunk.length ||
      new Set(states.map((state) => state.object)).size !== chunk.length
    )
      throw new InvalidProtectedData();
    const byId = new Map(states.map((state) => [state.object, state]));
    const check = async (object: Opened) => {
      const state = byId.get(object.envelope.object);
      if (!state) throw new InvalidProtectedData();
      const raw = stockReferences(state.references);
      const references = await verifyStockReferences(
        raw,
        object.envelope,
        await signingKey(raw.author, raw.authorityGeneration),
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
    };
    for (let offset = 0; offset < chunk.length; offset += 16)
      checked.push(
        ...(await Promise.all(chunk.slice(offset, offset + 16).map(check))),
      );
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
    const key = await importSigningKey(
      history.identityCertificate(
        reference.author,
        reference.authorityGeneration,
      ).signingKey,
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
          reference.envelopeHash !== (await stockEnvelopeHash(previous)))) ||
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
        await stockEnvelopeHash(previous),
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
