import { createRequire } from "node:module";
import { test, expect } from "bun:test";
import { createBusinessDatabase, businessSchemaFingerprint } from "./database";
import { businessSchema, checkExpression, quoted } from "./schema";
import { projectCompleteRows } from "./projection";
import { projectCompleteSnapshot } from "./snapshot";
import { row } from "./rowCodec.test.mjs";
import { readBusinessRows } from "./products";

const require = createRequire(import.meta.url);
const duckdb = require("@duckdb/duckdb-wasm/blocking");

async function database() {
  const engine = await duckdb.createDuckDB({
    mvp: { mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm") },
    eh: { mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm") },
  }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await engine.instantiate();
  engine.open({ path: ":memory:", allowUnsignedExtensions: false, arrowLosslessConversion: false,
    query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: true } });
  const connection = engine.connect();
  return createBusinessDatabase({ connection, close: () => connection.close() });
}

test("DuckDB preserves exact identifiers and decimals without external file access", async () => {
  const db = await database();
  try {
    expect((await db.query("SELECT fingerprint FROM __client_schema")).rows[0].fingerprint).toBe(businessSchemaFingerprint);
    expect((await db.query("SELECT 9223372036854775807::BIGINT AS id,12345678901234567890.123::DECIMAL(23,3) AS price,-0.20::DECIMAL(3,2) AS negative,true AS enabled")).rows[0])
      .toEqual({ id: 9223372036854775807n, price: "12345678901234567890.123", negative: "-0.20", enabled: true });
    await expect(db.query("SELECT * FROM read_csv('/tmp/must-not-read')")).rejects.toThrow();
    for (const table of businessSchema.tables) {
      await db.query(`SELECT ${checkExpression(table)} AS accepted FROM ${quoted(table.name)} LIMIT 0`);
    }
  } finally { await db.close(); }
}, 15000);

test("prepared array parameters preserve empty lists and exact nested identifiers",async()=>{
  const db=await database();
  try {
    const fields=["name","address","äöü","a,b",'a"b',"a\\b","line\nbreak","literal\\n","\t\r\b\f","'single'"];
    const result=await db.query("SELECT $1::VARCHAR[] AS fields,$2::BIGINT[] AS ids,$3::BIGINT[] AS empty",[fields,["9223372036854775807"],[]]);
    expect(Array.from(result.rows[0].fields)).toEqual(fields);
    expect(Array.from(result.rows[0].ids)).toEqual([9223372036854775807n]);
    expect(Array.from(result.rows[0].empty)).toEqual([]);
  } finally {await db.close();}
},15000);

test("catalogue conversion preserves UTC microseconds without loading ICU or other extensions", async () => {
  const db = await database();
  try {
    await projectCompleteRows(db, [row("products", { id: "9223372036854775807", created_at: "2026-11-09T13:30:22.123456+02:00" })]);
    const result = await readBusinessRows(db, "products");
    expect(result[0].values.id).toBe("9223372036854775807");
    expect(result[0].values.created_at).toBe("2026-11-09T11:30:22.123456Z");
    expect((await db.query("SELECT count(*)::INT AS n FROM duckdb_extensions() WHERE loaded AND extension_name='icu'")).rows[0].n).toBe(0);
  } finally { await db.close(); }
}, 15000);

test("business checks and references reject invalid updates without replacing the last valid row", async () => {
  const db = await database();
  try {
    const customer = row("customers", { id: "100", name: "Musterbau GmbH" });
    await projectCompleteRows(db, [customer]);
    const offer = row("commercial_cases", { id: "200", reference: "AN-200", kind: "offer", status: "draft", title: "Innenputz", currency: "EUR", net_amount: "123.45", scope_item_ids: "[]", customer_id: "100" });
    await projectCompleteRows(db, [offer]);
    await expect(projectCompleteRows(db, [{ ...offer, values: { ...offer.values, status: "made-up-status", net_amount: "999.99" } }])).rejects.toThrow();
    await expect(projectCompleteRows(db, [{ ...offer, values: { ...offer.values, customer_id: "999" } }])).rejects.toThrow();
    const current = (await db.query("SELECT status,net_amount FROM commercial_cases WHERE id=200")).rows[0];
    expect(current).toEqual({ status: "draft", net_amount: "123.45" });
  } finally { await db.close(); }
}, 15000);

test("expression and partial unique keys keep category names and ready template assets consistent",async()=>{
  const db=await database();
  try {
    await projectCompleteRows(db,[row("products",{id:"100"}),row("product_categories",{product_id:"100",category:"Grundierung"})]);
    await expect(projectCompleteRows(db,[row("product_categories",{product_id:"100",category:"grundierung"})])).rejects.toThrow();
    const asset=row("document_template_assets",{id:"200",name:"Briefkopf.pdf",ready:false});
    const other=row("document_template_assets",{id:"201",name:"Briefkopf.pdf",ready:false});
    await projectCompleteRows(db,[asset,other]);
    await projectCompleteRows(db,[{...asset,values:{...asset.values,ready:true}}]);
    await expect(projectCompleteRows(db,[{...other,values:{...other.values,ready:true}}])).rejects.toThrow();
    expect((await db.query("SELECT count(*)::INT AS n FROM product_categories")).rows[0].n).toBe(1);
    expect((await db.query("SELECT ready FROM document_template_assets WHERE id=201")).rows[0].ready).toBe(false);
  } finally {await db.close();}
},15000);

test("a failed mutation rolls back and another request cannot enter its transaction", async () => {
  const db = await database();
  try {
    await db.exec("CREATE TABLE example(id BIGINT PRIMARY KEY, label VARCHAR NOT NULL)");
    await expect(db.transaction(async tx => {
      await tx.query("INSERT INTO example VALUES($1,$2)", ["1", "Anstrich"]);
      await tx.query("INSERT INTO example VALUES($1,$2)", ["1", "Doppelt"]);
    })).rejects.toThrow();
    expect((await db.query("SELECT count(*)::INT AS count FROM example")).rows[0].count).toBe(0);
    let release;
    const pause = new Promise(resolve => { release = resolve; });
    const transaction = db.transaction(async tx => {
      await tx.query("INSERT INTO example VALUES($1,$2)", ["2", "Aufmaß"]);
      await pause;
      throw new Error("Rollback");
    });
    const next = db.query("SELECT count(*)::INT AS count FROM example");
    release();
    await expect(transaction).rejects.toThrow("Rollback");
    expect((await next).rows[0].count).toBe(0);
  } finally { await db.close(); }
}, 15000);

async function* sources(rows) { for (const item of rows) yield item; }

test("a complete snapshot checks references across table order without rounding nested JSON", async () => {
  const db=await database();
  try {
    const name='{"id":9223372036854775807,"amount":1234567890123.45}';
    const count=await projectCompleteSnapshot(db,sources([
      row("commercial_cases",{id:"200",reference:"AN-200",kind:"offer",status:"draft",currency:"EUR",customer_id:"100",scope_item_ids:"[]"}),
      row("customers",{id:"100",name:"Musterbau GmbH"}),
      row("global_settings",{key:"precision",name}),
      row("global_settings",{key:"json-null",name:"null"}),
      row("global_settings",{key:"sql-null",name:null}),
    ]),new AbortController().signal);
    expect(count).toBe(5n);
    expect((await db.query("SELECT name FROM global_settings WHERE key='precision'")).rows[0].name).toBe(name);
    expect((await db.query("SELECT name FROM global_settings WHERE key='json-null'")).rows[0].name).toBe("null");
    expect((await db.query("SELECT name FROM global_settings WHERE key='sql-null'")).rows[0].name).toBeNull();
    await expect(projectCompleteSnapshot(db,sources([]),new AbortController().signal)).rejects.toThrow();
  } finally { await db.close(); }
},15000);

test("incomplete, duplicate and interrupted snapshots leave no partially published rows", async () => {
  const db=await database();
  try {
    const signal=new AbortController();
    const invalid=row("commercial_cases",{id:"200",reference:"AN-200",kind:"offer",status:"draft",currency:"EUR",customer_id:"999",scope_item_ids:"[]"});
    await expect(projectCompleteSnapshot(db,sources([row("customers",{id:"100"}),invalid]),signal.signal)).rejects.toThrow();
    const duplicate=row("customers",{id:"100"});
    await expect(projectCompleteSnapshot(db,sources([duplicate,duplicate]),signal.signal)).rejects.toThrow();
    async function* interrupted() {yield duplicate;signal.abort();}
    await expect(projectCompleteSnapshot(db,interrupted(),signal.signal)).rejects.toThrow();
    expect((await db.query("SELECT count(*)::INT AS n FROM customers")).rows[0].n).toBe(0);
  } finally { await db.close(); }
},15000);

test("binary floating-point quantities survive the browser database without one-ULP rounding", async () => {
  const db = await database();
  try {
    for (const quantity of [50.019999999999996, 0.30000000000000004, 98765.4321, -12.345678901234567]) {
      expect((await db.query("SELECT $1::DOUBLE AS value", [String(quantity)])).rows[0].value).toBe(quantity);
      expect((await db.query("SELECT $1::DOUBLE AS value", [quantity])).rows[0].value).toBe(quantity);
      await projectCompleteRows(db, [row("products", { id: "1" }), row("projects", { id: "3" }), row("product_delivery_notes", { id: "2", project_id: "3" }), row("product_delivery_records", { id: "4", note_id: "2", product_id: "1", quantity })]);
      expect((await readBusinessRows(db, "product_delivery_records"))[0].values.quantity).toBe(quantity);
    }
  } finally { await db.close(); }
}, 15000);


test("exact floating bindings leave literal text, identifiers and SQL comments intact", async () => {
  const db = await database();
  try {
    const sql = "SELECT '$1' AS literal,$$value $1$$ AS quoted,$tag$value $1$tag$ AS tagged,E'it\\'s $1' AS escaped,$1::DOUBLE AS \"$1\" /* $1 /* nested $1 */ */ -- $1\n";
    expect((await db.query(sql, [50.019999999999996])).rows[0]).toEqual({ literal: "$1", quoted: "value $1", tagged: "value $1", escaped: "it's $1", "$1": 50.019999999999996 });
  } finally { await db.close(); }
}, 15000);
