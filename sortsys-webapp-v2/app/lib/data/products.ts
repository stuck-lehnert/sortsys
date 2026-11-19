import type {
  Client,
  MutateInput,
  QueryInput,
  QueryResult,
} from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { createPrefixMatcher } from "../search/prefixQuery";
import type { BusinessDatabase, DuckDriver } from "./database";
import { decodeBusinessRow } from "./rowCodec";
import type { BusinessRow } from "./rowCodec";
import { businessSchema, quoted, tableDefinition } from "./schema";
import type { Collection } from "./protectedObjects";
import { acquireDataRuntime } from "./runtime/session";
import { defineDataModel } from "./runtime/model";

export const PRODUCT_COLLECTION: Collection = {
  domain: "catalog:products:master-data",
  scope: "catalog:products",
  facet: "master-data",
  prefix: "product:",
};
export const PRICE_COLLECTION: Collection = {
  domain: "catalog:products:procurement",
  scope: "catalog:products",
  facet: "procurement",
  prefix: "product-price:",
};

export type ProductPayload = {
  format: "sortsys-product-v1";
  product: BusinessRow;
  categories: BusinessRow[];
};
export type PricePayload = {
  format: "sortsys-product-price-v1";
  price: BusinessRow;
};

export function publicId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new InvalidProtectedData();
  return BigInt(value).toString(32);
}

export function newProductRowId(): string {
  let id = 0n;
  while (!id) {
    for (const byte of crypto.getRandomValues(new Uint8Array(8)))
      id = (id << 8n) | BigInt(byte);
    id &= 9223372036854775807n;
  }
  return id.toString();
}

const PRODUCT_FIELDS = {
  customId: "custom_id",
  name: "name",
  brand: "brand",
  description: "description",
  regieReportName: "regie_report_name",
  baseUnit: "base_unit",
  otherUnits: "other_units",
} as const;

export function productChanges(
  input: unknown,
  creating: boolean,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(PRODUCT_FIELDS, key))
  )
    throw new InvalidProtectedData();
  const source = input as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(PRODUCT_FIELDS)) {
    if (source[field] === undefined && !creating) continue;
    const value = source[field];
    if (field === "customId") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 2147483647
      )
        throw new InvalidProtectedData();
      values[column] = value.toString();
    } else if (field === "otherUnits") {
      const units = value ?? {};
      if (!units || typeof units !== "object" || Array.isArray(units))
        throw new InvalidProtectedData();
      values[column] = JSON.stringify(units);
    } else if (["name", "baseUnit"].includes(field)) {
      if (typeof value !== "string" || !value.trim())
        throw new InvalidProtectedData();
      values[column] = value.trim();
    } else {
      if (value !== undefined && value !== null && typeof value !== "string")
        throw new InvalidProtectedData();
      values[column] =
        typeof value === "string" && value.trim() ? value.trim() : null;
    }
  }
  return values;
}

export function productPayload(input: unknown, object: string): ProductPayload {
  const data = record(input, ["format", "product", "categories"]);
  if (
    data.format !== "sortsys-product-v1" ||
    !Array.isArray(data.categories) ||
    data.categories.length > 10_000
  )
    throw new InvalidProtectedData();
  const product = decodeBusinessRow(data.product);
  if (
    product.table !== "products" ||
    object !== `product:${publicId(product.values.id)}`
  )
    throw new InvalidProtectedData();
  if (
    BigInt(product.values.custom_id as string) < 0n ||
    !(product.values.name as string).trim() ||
    !(product.values.base_unit as string).trim()
  )
    throw new InvalidProtectedData();
  const units = JSON.parse(product.values.other_units as string);
  if (!units || typeof units !== "object" || Array.isArray(units))
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  const categories = data.categories.map((input) => {
    const row = decodeBusinessRow(input);
    if (
      row.table !== "product_categories" ||
      row.values.product_id !== product.values.id ||
      typeof row.values.category !== "string" ||
      !row.values.category.trim()
    )
      throw new InvalidProtectedData();
    const key = row.values.category.toLowerCase();
    if (seen.has(key)) throw new InvalidProtectedData();
    seen.add(key);
    return row;
  });
  categories.sort((a, b) =>
    (a.values.category as string).localeCompare(b.values.category as string),
  );
  return { format: "sortsys-product-v1", product, categories };
}

export function pricePayload(input: unknown, object: string): PricePayload {
  const data = record(input, ["format", "price"]);
  const price = decodeBusinessRow(data.price);
  if (
    data.format !== "sortsys-product-price-v1" ||
    price.table !== "product_price_records" ||
    object !== `product-price:${publicId(price.values.id)}`
  )
    throw new InvalidProtectedData();
  return { format: "sortsys-product-price-v1", price };
}
export const PRICE_MODEL = defineDataModel({
  name: "product-prices",
  decode: pricePayload,
  tables: ["product_price_records"],
  externalReferences: ["products", "product_vendors"],
  // Historical rows retain their signed supplier link. Today's mutable stock
  // reference cannot validate an earlier revision or rewrite its old meaning.
  historyOpened: (value: PricePayload) => value,
  opened(value, object) {
    if (object.envelope.revision !== "0" && !object.stock)
      throw new InvalidProtectedData();
    // A historical supplier deletion applies only to that supplier, including
    // while editing another field or assigning a different supplier later.
    if (
      value.price.values.vendor_id !== null &&
      object.stock?.vendorDeletion?.object ===
        `vendor:${publicId(value.price.values.vendor_id)}`
    )
      return {
        ...value,
        price: {
          ...value.price,
          values: { ...value.price.values, vendor_id: null },
        },
      };
    return value;
  },
});
export function wirePrice(
  payload: PricePayload,
): QueryResult<"products.priceRecords.list">[number] {
  const p = payload.price.values;
  return {
    id: publicId(p.id),
    productId: publicId(p.product_id),
    vendorId: p.vendor_id === null ? null : publicId(p.vendor_id),
    timestamp: new Date(p.timestamp as string),
    price: p.price as number,
    isRealPurchase: p.is_real_purchase as boolean,
    comment: p.comment as string | null,
  };
}

/** Price-only grants do not require opening the catalogue or its DuckDB view. */
export async function readProtectedPrices(
  client: Client,
  signal: AbortSignal,
  productId?: string,
  driver?: () => Promise<DuckDriver>,
): Promise<QueryResult<"products.priceRecords.list">> {
  const lease = acquireDataRuntime(client, signal, driver),
    request = { model: PRICE_MODEL, area: PRICE_COLLECTION };
  try {
    const result = await lease.runtime.read([request], (view) =>
      view
        .documents(request)
        .map((document) => wirePrice(document.value))
        .filter((price) => !productId || price.productId === productId)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    );
    lease.live();
    return result;
  } finally {
    lease.close();
  }
}

/** Select the migration's canonical wire types without rounding int64 IDs or
 * timestamps through JavaScript numbers/Date. No generated search columns. */
export async function readBusinessRows(
  database: BusinessDatabase,
  name: string,
): Promise<BusinessRow[]> {
  const table = tableDefinition(name);
  const columns = table.columns.map((column) => {
    const key = quoted(column.name);
    if (column.type.startsWith("_")) {
      const type = column.type.slice(1);
      const value =
        type.startsWith("int") || type === "numeric" || type === "date"
          ? "CAST(item AS VARCHAR)"
          : type === "timestamptz"
            ? "strftime(make_timestamp(epoch_us(item)),'%Y-%m-%dT%H:%M:%S.%fZ')"
            : "item";
      return `list_transform(${key},item -> ${value}) AS ${key}`;
    }
    if (
      column.type.startsWith("int") ||
      column.type === "numeric" ||
      column.type === "date"
    )
      return `CAST(${key} AS VARCHAR) AS ${key}`;
    if (column.type === "timestamptz")
      return `strftime(make_timestamp(epoch_us(${key})),'%Y-%m-%dT%H:%M:%S.%fZ') AS ${key}`;
    return key;
  });
  const rows = await database.query<Record<string, unknown>>(
    `SELECT ${columns.join(",")} FROM ${quoted(name)}`,
  );
  return rows.rows.map((values) =>
    decodeBusinessRow({
      format: "sortsys-row-v2",
      schema: businessSchema.fingerprint,
      table: name,
      values: Object.fromEntries(
        table.columns.map((column) => {
          let value = values[column.name];
          if (column.type.startsWith("_") && value !== null) {
            if (
              !value ||
              typeof value !== "object" ||
              !(Symbol.iterator in value)
            )
              throw new InvalidProtectedData();
            value = Array.from(value as Iterable<unknown>);
          }
          return [column.name, value];
        }),
      ),
    }),
  );
}

export async function productPayloads(
  database: BusinessDatabase,
): Promise<ProductPayload[]> {
  const products = await readBusinessRows(database, "products");
  const categories = new Map<string, BusinessRow[]>();
  for (const row of await readBusinessRows(database, "product_categories")) {
    const id = row.values.product_id as string;
    const list = categories.get(id) ?? [];
    list.push(row);
    categories.set(id, list);
  }
  return products.map((product) =>
    productPayload(
      {
        format: "sortsys-product-v1",
        product,
        categories: categories.get(product.values.id as string) ?? [],
      },
      `product:${publicId(product.values.id)}`,
    ),
  );
}

type Product = QueryResult<"products.get">;
function wireProduct(payload: ProductPayload): Product {
  const p = payload.product.values;
  return {
    id: publicId(p.id),
    customId: Number(p.custom_id),
    name: p.name as string,
    brand: p.brand as string | null,
    description: p.description as string | null,
    regieReportName: p.regie_report_name as string | null,
    baseUnit: p.base_unit as string,
    otherUnits: JSON.parse(p.other_units as string),
    categories: payload.categories
      .map((row) => row.values.category as string)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  };
}

export function createProductMatcher(search: string | null | undefined) {
  const matches = createPrefixMatcher(search);
  return (
    product: Pick<
      Product,
      "customId" | "name" | "brand" | "description" | "regieReportName"
    >,
  ) =>
    matches([
      product.customId,
      product.name,
      product.brand,
      product.description,
      product.regieReportName,
    ]);
}

/** A catalogue reader never requests or opens procurement keys. Price records
 * are loaded only on an explicit price query with its own signed permission. */
export const PRODUCT_MODEL = defineDataModel({
  name: "products",
  decode: productPayload,
  tables: ["products", "product_categories"],
});
const productRequest = { model: PRODUCT_MODEL, area: PRODUCT_COLLECTION };

export async function openProtectedProducts(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  const read = async <T>(
    work: (products: ProductPayload[]) => T,
  ): Promise<T> => {
    lease.live();
    const value = await runtime.read([productRequest], (view) =>
      work(view.documents(productRequest).map((document) => document.value)),
    );
    lease.live();
    return value;
  };
  function payload(products: ProductPayload[], id: string): ProductPayload {
    const value = products.find(
      (product) => publicId(product.product.values.id) === id,
    );
    if (!value) throw new InvalidProtectedData();
    return value;
  }
  async function editCategories(
    id: string,
    change: (labels: string[]) => string[],
  ) {
    lease.live();
    await runtime.transaction([productRequest], (tx) =>
      tx.edit(productRequest, PRODUCT_COLLECTION.prefix + id, (value) => {
        const labels = change(
          value.categories.map((row) => row.values.category as string),
        );
        if (!Array.isArray(labels) || labels.length > 10_000)
          throw new InvalidProtectedData();
        const unique = new Map<string, string>();
        for (const label of labels) {
          if (typeof label !== "string" || !label.trim())
            throw new InvalidProtectedData();
          const category = label.trim();
          if (!unique.has(category.toLowerCase()))
            unique.set(category.toLowerCase(), category);
        }
        value.categories = [...unique.values()].map((category) => ({
          format: "sortsys-row-v2",
          schema: businessSchema.fingerprint,
          table: "product_categories",
          values: { product_id: value.product.values.id, category },
        }));
      }),
    );
    lease.live();
    return { success: true as const };
  }
  try {
    await read(() => undefined);
  } catch (error) {
    lease.close();
    throw error;
  }
  return {
    async refresh(minimumSequence?: string) {
      lease.live();
      runtime.invalidate(
        new Set([PRODUCT_COLLECTION.domain]),
        minimumSequence === undefined
          ? undefined
          : new Map([[PRODUCT_COLLECTION.domain, minimumSequence]]),
      );
      await read(() => undefined);
    },
    list(
      input: QueryInput<"products.list">,
    ): Promise<QueryResult<"products.list">> {
      return read((products) => {
        const category = input?.category?.trim();
        const matches = createProductMatcher(input?.search);
        return products
          .map(wireProduct)
          .filter(
            (product) =>
              (!category || product.categories.includes(category)) &&
              matches(product),
          )
          .map((product) =>
            category ? { ...product, categories: [category] } : product,
          )
          .sort((a, b) => a.customId - b.customId);
      });
    },
    get: (id: string): Promise<Product> =>
      read((products) => wireProduct(payload(products, id))),
    categories: () =>
      read((products) =>
        [
          ...new Set(
            products.flatMap((product) =>
              product.categories.map((row) => row.values.category as string),
            ),
          ),
        ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      ),
    units: () =>
      read((products) => [
        ...new Set(
          products.flatMap((product) => [
            product.product.values.base_unit as string,
            ...Object.keys(
              JSON.parse(product.product.values.other_units as string),
            ),
          ]),
        ),
      ]),
    brands: () =>
      read((products) =>
        [
          ...new Set(
            products
              .map((product) => product.product.values.brand)
              .filter((brand): brand is string => typeof brand === "string"),
          ),
        ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      ),
    suggestNextCustomId: () =>
      read((products) => {
        const next =
          products.reduce(
            (max, product) =>
              Math.max(max, Number(product.product.values.custom_id)),
            0,
          ) + 1;
        if (next > 2147483647) throw new InvalidProtectedData();
        return next;
      }),
    async prices(
      productId?: string,
    ): Promise<QueryResult<"products.priceRecords.list">> {
      lease.live();
      const value = await readProtectedPrices(
        client,
        signal,
        productId,
        driver,
      );
      lease.live();
      return value;
    },
    async replace(input: unknown) {
      lease.live();
      const raw = record(input, ["format", "product", "categories"]),
        row = decodeBusinessRow(raw.product),
        id = PRODUCT_COLLECTION.prefix + publicId(row.values.id),
        value = productPayload(input, id);
      await runtime.transaction([productRequest], (tx) => {
        if (tx.documents(productRequest).some((document) => document.id === id))
          tx.edit(productRequest, id, (previous) =>
            Object.assign(previous, value),
          );
        else tx.create(productRequest, id, value);
      });
      lease.live();
    },
    async create(input: MutateInput<"products.create">) {
      lease.live();
      const id = newProductRowId(),
        now = new Date().toISOString(),
        changes = productChanges(input, true);
      await runtime.transaction([productRequest], (tx) =>
        tx.create(productRequest, PRODUCT_COLLECTION.prefix + publicId(id), {
          format: "sortsys-product-v1",
          categories: [],
          product: {
            format: "sortsys-row-v2",
            schema: businessSchema.fingerprint,
            table: "products",
            values: { id, ...changes, created_at: now, modified_at: now },
          },
        }),
      );
      lease.live();
      return { id: publicId(id) };
    },
    async update(input: MutateInput<"products.update">) {
      lease.live();
      const request = record(input, ["id", "data"]);
      if (typeof request.id !== "string") throw new InvalidProtectedData();
      const changes = productChanges(request.data, false),
        now = new Date().toISOString();
      await runtime.transaction([productRequest], (tx) => {
        const current = payload(
          tx.documents(productRequest).map((document) => document.value),
          request.id as string,
        );
        tx.patch(
          "products",
          { id: current.product.values.id },
          { ...changes, modified_at: now },
        );
      });
      lease.live();
      return { success: true as const };
    },
    async remove(id: string) {
      lease.live();
      if (!/^(?:[1-9a-v][0-9a-v]{0,11}|[1-7][0-9a-v]{12})$/.test(id))
        throw new InvalidProtectedData();
      await runtime.removeStock(productRequest, PRODUCT_COLLECTION.prefix + id);
      lease.live();
      return { success: true as const };
    },
    setCategories: (id: string, labels: string[]) =>
      editCategories(id, () => labels),
    tag: (id: string, label: string) =>
      editCategories(id, (labels) => [...labels, label]),
    untag: (id: string, label: string) =>
      editCategories(id, (labels) => {
        if (typeof label !== "string" || !label.trim())
          throw new InvalidProtectedData();
        return labels.filter(
          (category) => category.toLowerCase() !== label.trim().toLowerCase(),
        );
      }),
    close: async () => lease.close(),
  };
}
