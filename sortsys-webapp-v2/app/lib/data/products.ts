import type {
  Client,
  MutateInput,
  QueryInput,
  QueryResult,
} from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { buildPrefixSearch, createPrefixMatcher } from "../search/prefixQuery";
import type { BusinessDatabase, DuckDriver } from "./database";
import { decodeBusinessRow } from "./rowCodec";
import type { BusinessRow } from "./rowCodec";
import { businessSchema, quoted, tableDefinition } from "./schema";
import type { Collection } from "./protectedObjects";
import { acquireDataRuntime } from "./runtime/session";
import { defineDataModel } from "./runtime/model";
import type { DataCommand, DataTransaction } from "./runtime/runtime";

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

export const PRICE_MUTATIONS = new Set([
  "products.priceRecords.create",
  "products.priceRecords.update",
  "products.priceRecords.delete",
]);

export type ProductPayload = {
  format: "sortsys-product-v1";
  product: BusinessRow;
  categories: BusinessRow[];
};
export type PricePayload = {
  format: "sortsys-product-price-v1";
  price: BusinessRow;
};

const PRODUCT_ID = /^(?:[1-9a-v][0-9a-v]{0,11}|[1-7][0-9a-v]{12})$/;

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
export const priceRequest = { model: PRICE_MODEL, area: PRICE_COLLECTION };

export function wirePrice(
  price: BusinessRow,
): QueryResult<"products.priceRecords.list">[number] {
  const p = price.values;
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
  const lease = acquireDataRuntime(client, signal, driver);
  try {
    const result = await lease.runtime.read([priceRequest], (view) =>
      view
        .documents(priceRequest)
        .map(({ value }) => wirePrice(value.price))
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

export function productUnits(
  payload: ProductPayload,
): Pick<Product, "baseUnit" | "otherUnits"> {
  const { base_unit, other_units } = payload.product.values;
  return {
    baseUnit: base_unit as string,
    otherUnits: JSON.parse(other_units as string),
  };
}

function wireProduct(payload: ProductPayload): Product {
  const p = payload.product.values;
  return {
    id: publicId(p.id),
    customId: Number(p.custom_id),
    name: p.name as string,
    brand: p.brand as string | null,
    description: p.description as string | null,
    regieReportName: p.regie_report_name as string | null,
    ...productUnits(payload),
    categories: payload.categories
      .map((row) => row.values.category as string)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  };
}

function productSearchFields(
  product: Pick<
    Product,
    "customId" | "name" | "brand" | "description" | "regieReportName"
  >,
) {
  return [
    product.customId,
    product.name,
    product.brand,
    product.description,
    product.regieReportName,
  ];
}
export function createProductMatcher(search: string | null | undefined) {
  const matches = createPrefixMatcher(search);
  return (product: Parameters<typeof productSearchFields>[0]) =>
    matches(productSearchFields(product));
}

/** A catalogue reader never requests or opens procurement keys. Price records
 * are loaded only on an explicit price query with its own signed permission. */
export const PRODUCT_MODEL = defineDataModel({
  name: "products",
  decode: productPayload,
  tables: ["products", "product_categories"],
});
const productRequest = { model: PRODUCT_MODEL, area: PRODUCT_COLLECTION };
const productSearch = Symbol("product search");

export const PRODUCT_WRITE_ACTIONS = {
  "products.create": "create",
  "products.update": "update",
  "products.categories.set": "update",
  "products.categories.tag": "update",
  "products.categories.untag": "update",
} as const;

type ProductWritePath = keyof typeof PRODUCT_WRITE_ACTIONS;
type ProductWriteResult = { id: string } | { success: true };

export function isProductWrite(path: string): path is ProductWritePath {
  return Object.hasOwn(PRODUCT_WRITE_ACTIONS, path);
}

function createProduct(input: unknown) {
  const id = newProductRowId();
  const now = new Date().toISOString();
  const changes = productChanges(input, true);
  return (tx: DataTransaction) => {
    tx.create(productRequest, PRODUCT_COLLECTION.prefix + publicId(id), {
      format: "sortsys-product-v1",
      categories: [],
      product: {
        format: "sortsys-row-v2",
        schema: businessSchema.fingerprint,
        table: "products",
        values: { id, ...changes, created_at: now, modified_at: now },
      },
    });
    return { id: publicId(id) };
  };
}

function updateProduct(input: unknown) {
  const { id, data } = record(input, ["id", "data"]);
  if (typeof id !== "string") throw new InvalidProtectedData();
  const changes = productChanges(data, false);
  const now = new Date().toISOString();
  return (tx: DataTransaction) => {
    tx.require(productRequest, "update");
    const current = tx.documents(productRequest).find(
      (document) => document.id === PRODUCT_COLLECTION.prefix + id,
    );
    if (!current) throw new InvalidProtectedData();
    tx.patch(
      "products",
      { id: current.value.product.values.id },
      { ...changes, modified_at: now },
    );
    return { success: true as const };
  };
}

function editProductCategories(id: string, change: (labels: string[]) => unknown) {
  return (tx: DataTransaction) => {
    tx.require(productRequest, "update");
    tx.edit(productRequest, PRODUCT_COLLECTION.prefix + id, (value) => {
      const labels = change(
        value.categories.map((row) => row.values.category as string),
      );
      if (!Array.isArray(labels) || labels.length > 10_000) throw new InvalidProtectedData();
      const unique = new Map<string, string>();
      for (const label of labels) {
        if (typeof label !== "string" || !label.trim()) throw new InvalidProtectedData();
        const category = label.trim();
        const key = category.toLowerCase();
        if (!unique.has(key)) unique.set(key, category);
      }
      value.categories = [...unique.values()].map((category) => ({
        format: "sortsys-row-v2",
        schema: businessSchema.fingerprint,
        table: "product_categories",
        values: { product_id: value.product.values.id, category },
      }));
    });
    return { success: true as const };
  };
}

function editProductCategory(id: string, label: unknown, add: boolean) {
  if (typeof label !== "string" || !label.trim()) throw new InvalidProtectedData();
  const category = label.trim().toLowerCase();
  return editProductCategories(id, (labels) => {
    if (add) return [...labels, label];
    return labels.filter((current) => current.toLowerCase() !== category);
  });
}

export function productCommand(
  path: ProductWritePath,
  input: unknown,
): DataCommand<ProductWriteResult> {
  const requests = [productRequest];
  if (path === "products.create") return { requests, apply: createProduct(input) };
  if (path === "products.update") return { requests, apply: updateProduct(input) };

  const key = path === "products.categories.set" ? "categories" : "category";
  const data = record(input, ["id", key]);
  if (typeof data.id !== "string") throw new InvalidProtectedData();
  const apply = path === "products.categories.set"
    ? editProductCategories(data.id, () => data.categories)
    : editProductCategory(data.id, data.category, path === "products.categories.tag");
  return { requests, apply };
}

export function openProtectedProducts(
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
  async function write<T>(apply: (tx: DataTransaction) => T): Promise<T> {
    lease.live();
    const result = await runtime.transaction([productRequest], apply);
    lease.live();
    return result;
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
      await runtime.read([productRequest], () => undefined);
      lease.live();
    },
    async list(
      input: QueryInput<"products.list">,
      limit?: number,
    ): Promise<QueryResult<"products.list">> {
      lease.live();
      const category = input?.category?.trim();
      const rows = await runtime.read(
        [productRequest],
        (view) => {
          lease.live();
          const search = view.derive(productSearch, [productRequest], () =>
            buildPrefixSearch(
              view
                .documents(productRequest)
                .map(({ value }) => wireProduct(value))
                .sort((a, b) => a.customId - b.customId),
              productSearchFields,
            ),
          );
          return search(
            input?.search,
            (product) => !category || product.categories.includes(category),
            limit,
          );
        },
        undefined,
        { batchDirectory: limit !== undefined },
      );
      lease.live();
      if (category) {
        for (const product of rows) product.categories = [category];
      }
      return rows;
    },
    async get(id: string): Promise<Product> {
      lease.live();
      if (id !== "0" && !PRODUCT_ID.test(id)) throw new InvalidProtectedData();

      const request = {
        ...productRequest,
        ids: [PRODUCT_COLLECTION.prefix + id],
      };
      const product = await runtime.read(
        [request],
        (view) => {
          const [document] = view.documents(request);
          if (!document) throw new InvalidProtectedData();
          return wireProduct(document.value);
        },
        undefined,
        { batchDirectory: true },
      );
      lease.live();
      return product;
    },
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
          products.flatMap((product) => {
            const { baseUnit, otherUnits } = productUnits(product);
            return [baseUnit, ...Object.keys(otherUnits)];
          }),
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
    create: async (input: MutateInput<"products.create">) =>
      write(createProduct(input)),
    update: async (input: MutateInput<"products.update">) =>
      write(updateProduct(input)),
    async remove(id: string) {
      lease.live();
      if (!PRODUCT_ID.test(id)) throw new InvalidProtectedData();
      await runtime.removeStock(productRequest, PRODUCT_COLLECTION.prefix + id);
      lease.live();
      return { success: true as const };
    },
    setCategories: async (id: string, labels: string[]) =>
      write(editProductCategories(id, () => labels)),
    tag: async (id: string, label: string) =>
      write(editProductCategory(id, label, true)),
    untag: async (id: string, label: string) =>
      write(editProductCategory(id, label, false)),
    close: async () => lease.close(),
  };
}
