import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { protectedCollection } from "./protectedObjects";
import { createBusinessDatabase } from "./database";
import type { DuckDriver } from "./database";
import { projectCompleteRows } from "./projection";
import {
  PRODUCT_COLLECTION,
  newProductRowId,
  productChanges,
  productPayload,
  publicId,
} from "./products";
import type { ProductPayload } from "./products";
import { businessSchema } from "./schema";
import type { PreparedWrites } from "./atomicWrites";
import { jsonValue } from "./jsonValue";
import type { JsonValue } from "./jsonValue";

export const PRODUCT_MUTATIONS = [
  "products.create",
  "products.update",
  "products.categories.set",
  "products.categories.tag",
  "products.categories.untag",
] as const;
export type ChatOperation = {
  path: string;
  input: Record<string, JsonValue>;
  description: string;
};
export type ProductOperation = ChatOperation;
export type OperationOutput = {
  path: string;
  output: { id: string } | { success: true };
};

export function chatOperation(input: unknown): ChatOperation {
  const data = record(input, ["path", "input", "description"]);
  if (
    typeof data.path !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(data.path) ||
    data.path.length > 160 ||
    typeof data.description !== "string" ||
    data.description.includes("\0") ||
    !data.description.trim() ||
    new TextEncoder().encode(data.description).length > 500 ||
    !data.input ||
    typeof data.input !== "object" ||
    Array.isArray(data.input)
  )
    throw new InvalidProtectedData();
  return {
    path: data.path,
    input: jsonValue(data.input) as Record<string, JsonValue>,
    description: data.description.trim(),
  };
}
export function productOperation(input: unknown): ProductOperation {
  const operation = chatOperation(input);
  if (
    !PRODUCT_MUTATIONS.includes(
      operation.path as (typeof PRODUCT_MUTATIONS)[number],
    )
  )
    throw new InvalidProtectedData();
  return operation;
}
function categories(payload: ProductPayload, labels: unknown): ProductPayload {
  if (!Array.isArray(labels) || labels.length > 10000)
    throw new InvalidProtectedData();
  const unique = new Map<string, string>();
  for (const label of labels) {
    if (typeof label !== "string" || !label.trim())
      throw new InvalidProtectedData();
    if (!unique.has(label.trim().toLowerCase()))
      unique.set(label.trim().toLowerCase(), label.trim());
  }
  return {
    ...payload,
    categories: [...unique.values()].map((category) => ({
      format: "sortsys-row-v2",
      schema: businessSchema.fingerprint,
      table: "product_categories",
      values: { product_id: payload.product.values.id, category },
    })),
  };
}

/** Prepare a complete checked final catalogue and its encrypted differences.
 * Nothing is written here, including when the model asks to propose a change. */
export async function prepareProductOperations(
  client: Client,
  inputs: unknown[],
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<PreparedWrites & { outputs: OperationOutput[] }> {
  if (!inputs.length || inputs.length > 10) throw new InvalidProtectedData();
  const collection = await protectedCollection(
    client,
    PRODUCT_COLLECTION,
    signal,
  );
  try {
    const existing = await collection.read(),
      head = collection.snapshot();
    const pool = new Map(
      existing.map((object) => [
        object.envelope.object,
        productPayload(object.value, object.envelope.object),
      ]),
    );
    const outputs: OperationOutput[] = [],
      touched = new Set<string>();
    for (const raw of inputs) {
      signal.throwIfAborted();
      const operation = productOperation(raw),
        path = operation.path;
      let id: string, next: ProductPayload;
      if (path === "products.create") {
        const rawId = newProductRowId(),
          now = new Date().toISOString();
        id = `product:${publicId(rawId)}`;
        next = {
          format: "sortsys-product-v1",
          categories: [],
          product: {
            format: "sortsys-row-v2",
            schema: businessSchema.fingerprint,
            table: "products",
            values: {
              id: rawId,
              ...productChanges(operation.input, true),
              created_at: now,
              modified_at: now,
            },
          },
        };
        outputs.push({ path, output: { id: publicId(rawId) } });
      } else {
        const data = record(
          operation.input,
          path === "products.update"
            ? ["id", "data"]
            : path === "products.categories.set"
              ? ["id", "categories"]
              : ["id", "category"],
        );
        if (typeof data.id !== "string") throw new InvalidProtectedData();
        id = `product:${data.id}`;
        const current = pool.get(id);
        if (!current) throw new InvalidProtectedData();
        if (path === "products.update")
          next = {
            ...current,
            product: {
              ...current.product,
              values: {
                ...current.product.values,
                ...productChanges(data.data, false),
                modified_at: new Date().toISOString(),
              },
            },
          };
        else if (path === "products.categories.set")
          next = categories(current, data.categories);
        else {
          if (typeof data.category !== "string" || !data.category.trim())
            throw new InvalidProtectedData();
          const previous = current.categories.map(
            (row) => row.values.category as string,
          );
          next = categories(
            current,
            path === "products.categories.tag"
              ? [...previous, data.category]
              : previous.filter(
                  (label) =>
                    label.toLowerCase() !==
                    (data.category as string).trim().toLowerCase(),
                ),
          );
        }
        outputs.push({ path, output: { success: true } });
      }
      pool.set(id, productPayload(next, id));
      touched.add(id);
    }
    const database = await createBusinessDatabase(await driver?.());
    try {
      const values = [...pool.values()];
      for (let offset = 0; offset < values.length; offset += 500) {
        signal.throwIfAborted();
        await projectCompleteRows(
          database,
          values
            .slice(offset, offset + 500)
            .flatMap((payload) => [payload.product, ...payload.categories]),
        );
      }
    } finally {
      await database.close();
    }
    const packets = await Promise.all(
      [...touched].map((id) =>
        collection.packet(
          id,
          pool.get(id)!,
          existing.find((object) => object.envelope.object === id)?.envelope,
        ),
      ),
    );
    signal.throwIfAborted();
    return {
      packets,
      head: { domain: PRODUCT_COLLECTION.domain, sequence: head },
      outputs,
      async verify() {
        const actual = await collection.read();
        return packets.every(
          (packet) =>
            actual.find(
              (object) => object.envelope.object === packet.envelope.object,
            )?.envelope.signature === packet.envelope.signature,
        );
      },
      close() {
        collection.close();
      },
    };
  } catch (error) {
    collection.close();
    throw error;
  }
}
