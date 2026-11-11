// Destructive, disposable test tenant only. scripts/test-api owns its lifetime.
import assert from "node:assert/strict";
import { createClient, type MutateInput } from "@sortsys/v2-client";
import { createRequire } from "node:module";
import { openArchivedDatabase } from "../app/lib/data/bootstrap";
import { archiveLegacyData } from "../app/lib/crypto/migration";
import { commitTenantSetup, prepareTenantSetup } from "../app/lib/crypto/setup";
import { commitRecovery, recoveryDraft, recoveryPlan } from "../app/lib/crypto/recovery";
import { changeOwnPassword, enrollPasswordAccount, lockCryptoSession, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { accountVaultFrame, createAccountVault, digest, frame, sign } from "@sortsys/zerotrust";
import { testProtectedProducts } from "./test-live-products";
import { capturedStock, testProtectedStock } from "./test-live-stock";
import { testProtectedDeliveryNotes, testDeliveryNoteRecovery } from "./test-live-delivery-notes";
import { testDeliveryWrites } from "./test-live-delivery-writes";
import { testProtectedPriceImports } from "./test-live-price-imports";
import { testLiveLlm } from "./test-live-llm";
import { testLiveEvents } from "./test-live-events";
import { testLiveInvitations } from "./test-live-invitations";
import { testProtectedAddressBook } from "./test-live-address-book";
import { testProtectedProjectFiles } from "./test-live-project-files";
import { testProtectedProjects } from "./test-live-projects";
import { testProtectedTools } from "./test-live-tools";
import { testProtectedCommercial } from "./test-live-commercial";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openProtectedProducts } from "../app/lib/data/products";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { testProtectedGaebDocuments, gaebTestProcessor } from "./test-live-gaeb";
import { testGaebDocumentWorkflows } from "./test-live-gaeb-workflows";
import { testCommercialWorkflows } from "./test-live-commercial-workflows";
import { testContractAdoption } from "./test-live-commercial-adoption";
import { testProtectedOrganization } from "./test-live-organization";
import { seedPreferences, testProtectedPreferences, capturedPreferences } from "./test-live-preferences";
import { testProtectedPositions } from "./test-live-positions";
import { seedPrintTemplates, testProtectedPrintTemplates } from "./test-live-print-templates";

if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("This script only runs inside the disposable API test stack");
const positionsMembersOnly = process.argv.includes("--position-members");
const preferencesOnly = process.argv.includes("--preferences");
const stockOnly = process.argv.includes("--stock");
const frameworkOnly = process.argv.includes("--framework");
const toolsOnly = process.argv.includes("--tools");
const deliveryOnly = process.argv.includes("--delivery-notes") || frameworkOnly || toolsOnly;
const organizationPrintOnly = process.argv.includes("--organization-print") || positionsMembersOnly || preferencesOnly || stockOnly;
const positionsOnly = process.argv.includes("--positions");
const endpoint=process.env.SORTSYS_MIGRATION_TEST_API;
if (!endpoint || !/^http:\/\/[A-Za-z0-9_.-]+:3000$/.test(endpoint)) throw new Error("An isolated test API endpoint is required");
const tenant=process.env.SORTSYS_MIGRATION_TEST_TENANT ?? "test";
const client=createClient(endpoint,"migration-integration-test");
async function required<T>(promise:Promise<[T|null,Error|null]>):Promise<T> {
  const [result,error]=await promise;
  if(error) throw error;
  if(result===null) throw new Error("Expected test result");
  return result;
}
const login=await required(client.mutate("auth.login",{tenant,username:"john.doe",password:"123456"}));
const original=await required(client.query("auth.sessionInfo",undefined,{strategy:"network-only"}));
const subject=`user:${original.user.id}`;
const toolNumber = await required(client.query("tools.suggestNextCustomId", undefined));
const toolFixture = await required(client.mutate("tools.create", { customId: toolNumber, brand: "Migrationsprüfung", category: "Freigabeprüfung", label: "Werkzeug vor dem Kontowechsel", usageCostPerDay: 17.375 }));
await required(client.mutate("tools.track", { id: toolFixture.id, data: { responsibleUserId: original.user.id } }));
await required(client.mutate("settings.organization.set", { companyName: "Musterbetrieb Organisationsprüfung", address: {
  streetAddress: "Handwerkerweg 19", city: "Nürnberg", zip: "90408", country: "DE",
} }));
await required(client.mutate("settings.invoiceNumbering.set", { scheme: "projectLocal", startNumber: "1234567890123456789" }));
const organizationBaseline = await required(client.query("settings.organization.get", undefined, { strategy: "network-only" }));
const numberingBaseline = await required(client.query("settings.invoiceNumbering.get", undefined, { strategy: "network-only" }));
const printBaseline = await seedPrintTemplates(client);
const vendorBaseline = await required(client.query("products.vendors.list", {}, { strategy: "network-only" }));
// Do not depend on optional development model configuration to grant this
// test account its existing application role before the encrypted cutover.
const invitedUser = (await required(client.query("users.list", { search: "frank.doe" }))).find(user => user.username === "frank.doe")!;
await seedPreferences(client, invitedUser.id);
const roleNames = await required(client.query("users.roles.list", undefined));
const assignments = Object.fromEntries(roleNames.map(role => [role, role === ":llm" ? true : null])) as MutateInput<"users.roles.set">["assignments"];
await required(client.mutate("users.roles.set", { userId: invitedUser.id, assignments }));
let describedProduct = "";
for (let i = 0; i < 35; i++) {
  const created = await required(client.mutate("products.create", { customId: 1000000 + i, name: `Prüfprodukt ${i}`,
    description: i === 0 ? "Bogenberechnung als Beschreibungstreffer" : `Bogenberechnung Bereich ${i}`, baseUnit: "m²", otherUnits: {},
  }));
  if (i === 0) describedProduct = created.id;
}
await required(client.mutate("products.priceRecords.create", { productId: describedProduct, pricePerBaseUnit: 97531.2468,
  timestamp: new Date("2026-11-09T00:00:00Z"), isRealPurchase: false }));
const productBaseline = await required(client.query("products.list", {}, { strategy: "network-only" }));
const descriptionMatches = await required(client.query("products.list", { search: "Bogenberechnung" }, { strategy: "network-only" }));
const addressCustomer = await required(client.mutate("customers.create", { name: "Migrationskunde Bauleitung", address: { city: "Nürnberg", streetAddress: "Pirckheimer Straße 123", zip: "90408" }, emailAddresses: [{ email: "bauleitung@migrationskunde.example" }] }));
const addressContact = await required(client.mutate("contacts.create", { firstName: "Petra", lastName: "Migrationskontakt", phoneNumbers: [{ number: "+49 123456" }] }));
await required(client.mutate("customers.contacts.add", { customerId: addressCustomer.id, contactId: addressContact.id }));
const customerBaseline = await required(client.query("customers.list", {}, { strategy: "network-only" }));
const contactBaseline = await required(client.query("contacts.list", {}, { strategy: "network-only" }));
const projectFixture = await required(client.mutate("projects.create", { title: "Projektübernahme Fenstersanierung", customerId: addressCustomer.id,
  responsibleProjectLeaderUserId: original.user.id, address: { city: "Regensburg", streetAddress: "Schulstraße 12" }, orderReceivedAt: new Date("2026-10-12T10:30:00Z") }));
await required(client.mutate("projects.contacts.add", { projectId: projectFixture.id, contactId: addressContact.id, label: "Bauleitung" }));
const projectBaseline = await required(client.query("projects.list", {}, { strategy: "network-only" }));
const deliveryBaseline = await required(client.query("deliveryNotes.list", {}, { strategy: "network-only" }));
const deliveryCostBaseline = new Map(await Promise.all(deliveryBaseline.map(async note => [note.id,
  await required(client.query("deliveryNotes.costs.get", { id: note.id }, { strategy: "network-only" }))] as const)));
const marker="Große Fensteröffnung äöü – Rohdaten bleiben unverändert. ";
const longText=marker.repeat(4500);
const raw=`{"0":{"json":{"key":"zerotrust.migration.precision-test","name":{"id":9223372036854775807,"amount":1234567890123.45,"text":${JSON.stringify(longText)}}}}}`;
const seeded=await fetch(`${endpoint}/settings.global.set?batch=1`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${login.token}`},body:raw});
assert.equal(seeded.ok,true);
const seededReply=await seeded.json();
assert.equal(seededReply[0]?.error,undefined);
const offer=await required(client.mutate("commercial.cases.create",{kind:"offer",title:"Verschlüsselungstest Innenputz",scopeItemIds:[]}));
await required(client.mutate("commercial.documents.create",{caseId:offer.id,purpose:"offer",fileName:"Verschlüsselungstest.x84",xml:createGaebXml("84","Verschlüsselungstest Innenputz","2026-11-10"),readOnly:false,netAmount:"1234567890123.45"}));
await required(client.mutate("commercial.cases.update",{id:offer.id,title:"Verschlüsselungstest Innenputz",customerId:addressCustomer.id,counterpartyName:null,validUntil:"2026-12-24",notes:"Vertraulicher Lohnansatz 53,71 Euro"}));
const commercialBaseline=await required(client.query("commercial.cases.get",{id:offer.id},{strategy:"network-only"}));
const password="123456"; // Normal sign-in performs enrollment without a second password.
// This non-browser runner has no IndexedDB trust marker and deliberately cannot
// authorize a legacy sign-in. Exercise its already authenticated enrollment,
// then verify the ordinary OPAQUE login using the unchanged password.
await enrollPasswordAccount(client,{tenant,username:"john.doe",password});
const enrolledIdentity = unlockedAccount()!.vault.signingKey;
const changedPassword = "Public-Self-Password-Test-2026!";
await changeOwnPassword(client,changedPassword);
await signIn(client,{tenant,username:"john.doe",password:changedPassword});
assert.equal(unlockedAccount()!.vault.signingKey,enrolledIdentity,"A password change must retain the existing identity");
// Restore this synthetic account's seeded credential before the migration test.
await enrollPasswordAccount(client,{tenant,username:"john.doe",password});
await signIn(client,{tenant,username:"john.doe",password});
assert.equal((await required(client.query("auth.opaque.mode",{tenant,username:"john.doe"},{strategy:"network-only"}))).opaque,true);
const draft=await prepareTenantSetup(tenant,subject,"john.doe");
await commitTenantSetup(client,draft,"john.doe");
console.log("Existing sign-in password retained; recovery setup required no additional password entry.");
// Updating the encrypted account settings must not need another password entry
// or change the identity. A bearer token alone must not authorize replacement.
const account = unlockedAccount()!;
const prior = await required(client.query("auth.opaque.vault",undefined,{strategy:"network-only"}));
const updated = await createAccountVault(account.exportKey,tenant,account.username,account.identity,account.pins);
const proof = await sign(account.identity.signingKey.privateKey,frame("sortsys/account-vault-update/v1",[
  tenant,account.username,prior.revision,await digest(accountVaultFrame(updated))
]));
const packet = {revision:prior.revision,vault:updated,proof};
await required(client.mutate("auth.opaque.vaultUpdate",packet));
const [, replay] = await client.mutate("auth.opaque.vaultUpdate",packet);
assert.ok(replay,"A stale account settings update must be rejected");
const latest = await required(client.query("auth.opaque.vault",undefined,{strategy:"network-only"}));
assert.equal(latest.revision,(BigInt(prior.revision)+1n).toString());
assert.deepEqual(latest.vault,updated);
const [,legacyError]=await client.query("commercial.cases.get",{id:offer.id},{strategy:"network-only"});
assert.ok(legacyError,"Legacy business reads must be closed after key setup");
const [,invalidWrite]=await client.mutateDynamic("products.create",{invalid:"must not reach the business parser"});
assert.ok(invalidWrite?.message.includes("encrypted data path"));

const controller=new AbortController();
let interrupted=false;
try {
  await archiveLegacyData(client,subject,progress=>{if(progress.done>0n)controller.abort();},controller.signal);
} catch {interrupted=true;}
assert.equal(interrupted,true);
const checkpoint=await required(client.query("zerotrust.migration.status",undefined,{strategy:"network-only"}));
assert.ok(checkpoint.tables.some(table=>BigInt(table.parts)>0n));

// Recover while a migration is interrupted. Previously secured chunks must stay
// readable from the new root, while subsequent chunks use fresh area keys.
const nextPassword="Public-test-recovered-password-12345";
const recovery=await recoveryDraft(client,tenant,draft.phrase,nextPassword);
const plan=await recoveryPlan(client,recovery);
await commitRecovery(client,plan);
await lockCryptoSession();client.setToken(null);
await signIn(client,{tenant,username:plan.username,password:nextPassword});
const newSubject=plan.nextSetup.owner.user;
await assert.rejects(()=>recoveryDraft(client,tenant,draft.phrase,nextPassword));
const complete=await archiveLegacyData(client,newSubject,()=>{},new AbortController().signal);
assert.equal(complete.phase,"copied");
assert.equal(complete.id,checkpoint.id);

const before=checkpoint.tables.find(table=>BigInt(table.parts)>0n)!;
const previousParts=await required(client.query("zerotrust.migration.parts",{id:complete.id,table:before.table,after:"0"},{strategy:"network-only"}));
assert.equal(previousParts[0]!.envelope.generation,"1");
assert.ok(complete.tables.some(table=>BigInt(table.parts)>BigInt(checkpoint.tables.find(old=>old.table===table.table)!.parts)));
const currentDomain=(await required(client.query("zerotrust.domains.list",undefined,{strategy:"network-only"}))).find(domain=>domain.id===`archive:${complete.id}`);
assert.equal(currentDomain?.generation,"2");

const require=createRequire(import.meta.url);
const duckdb=require("@duckdb/duckdb-wasm/blocking");
const engine=await duckdb.createDuckDB({mvp:{mainModule:require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm")},eh:{mainModule:require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm")}},new duckdb.VoidLogger(),duckdb.NODE_RUNTIME);
await engine.instantiate();
engine.open({path:":memory:",allowUnsignedExtensions:false,arrowLosslessConversion:false,query:{castBigIntToDouble:false,castDecimalToDouble:false,castTimestampToDate:true}});
const connection=engine.connect();
const projected=await openArchivedDatabase(client,newSubject,new AbortController().signal,{connection,close:()=>connection.close()});
try {
  const precision=(await projected.database.query<{name:string}>("SELECT name FROM global_settings WHERE key=$1",["zerotrust.migration.precision-test"])).rows[0]!.name;
  assert.ok(precision.includes("9223372036854775807"));
  assert.ok(precision.includes("1234567890123.45"));
  assert.equal(JSON.parse(precision).text,longText);
  assert.equal((await projected.database.query<{net_amount:string}>("SELECT net_amount FROM commercial_documents WHERE file_name=$1",["Verschlüsselungstest.x84"])).rows[0]!.net_amount,"1234567890123.45");
  assert.equal((await projected.database.query("SELECT name FROM global_settings WHERE key=$1",[`sortsys.legacy.organization.${complete.id}`])).rows.length,1);
  assert.equal(projected.rows,complete.tables.reduce((sum,table)=>sum+BigInt(table.rows),0n));
  const testDriver = async () => {
    const local = await duckdb.createDuckDB({ mvp: { mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm") },
      eh: { mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm") } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await local.instantiate();
    local.open({ path: ":memory:", allowUnsignedExtensions: false, arrowLosslessConversion: false,
      query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: true } });
    const conn = local.connect();
    return { connection: conn, close: () => conn.close() };
  };
  await testProtectedDeliveryNotes(client, projected.database, newSubject, testDriver, deliveryBaseline, deliveryCostBaseline, nextPassword);
  await testDeliveryWrites(client, testDriver, nextPassword);
  if (toolsOnly) {
    const { prepareProjects } = await import("../app/lib/data/migrateProjects");
    await prepareProjects(client, projected.database, newSubject, new AbortController().signal);
    await testProtectedTools(client, projected.database, testDriver, nextPassword);
  }
  if (frameworkOnly) {
    await testProtectedOrganization(client, projected.database, newSubject, organizationBaseline, numberingBaseline);
    await testProtectedPreferences(client, projected.database, newSubject);
    await testProtectedProducts(client, projected.database, newSubject, testDriver, productBaseline, descriptionMatches);
    await testProtectedStock(client, projected.database, newSubject, testDriver, vendorBaseline, productBaseline);
    await testProtectedAddressBook(client, projected.database, newSubject, testDriver, customerBaseline, contactBaseline, addressCustomer.id, addressContact.id, nextPassword);
    await testProtectedProjects(client, projected.database, newSubject, testDriver, projectBaseline, projectFixture.id, addressCustomer.id, addressContact.id, nextPassword);
    await testProtectedTools(client, projected.database, testDriver, nextPassword);
    await testCommercialWorkflows(client, testDriver, gaebTestProcessor, addressCustomer.id, nextPassword);
    const { preparePrintTemplates } = await import("../app/lib/data/migratePrintTemplates");
    const { preparePrivateLlm } = await import("../app/lib/data/privateLlm");
    await preparePrintTemplates(client, projected.database, newSubject, new AbortController().signal);
    await preparePrivateLlm(client, newSubject, new AbortController().signal);
    await testLiveEvents(client, nextPassword, testDriver);
    await testProtectedPriceImports(client, testDriver, nextPassword);
  }
  if (deliveryOnly) await testDeliveryNoteRecovery(client, testDriver, recovery.newPhrase);
  if (!deliveryOnly) {
  await testProtectedOrganization(client, projected.database, newSubject, organizationBaseline, numberingBaseline);
  await testProtectedPreferences(client, projected.database, newSubject);
  await testProtectedPrintTemplates(client, projected.database, newSubject, printBaseline);
  await testProtectedProducts(client, projected.database, newSubject, testDriver, productBaseline, descriptionMatches);
  await testProtectedStock(client, projected.database, newSubject, testDriver, vendorBaseline, productBaseline);
  if (positionsMembersOnly || preferencesOnly || stockOnly) {
    const { prepareAddressBook } = await import("../app/lib/data/migrateAddressBook");
    const { prepareProjects } = await import("../app/lib/data/migrateProjects");
    await prepareAddressBook(client, projected.database, newSubject, new AbortController().signal);
    await prepareProjects(client, projected.database, newSubject, new AbortController().signal);
  } else {
    await testProtectedAddressBook(client, projected.database, newSubject, testDriver, customerBaseline, contactBaseline, addressCustomer.id, addressContact.id, nextPassword);
    await testProtectedProjects(client, projected.database, newSubject, testDriver, projectBaseline, projectFixture.id, addressCustomer.id, addressContact.id, nextPassword);
  }
  if (organizationPrintOnly) {
    const { preparePrivateLlm } = await import("../app/lib/data/privateLlm");
    await preparePrivateLlm(client, newSubject, new AbortController().signal);
    await testLiveEvents(client, nextPassword, testDriver);
    await testLiveInvitations(client, testDriver, recovery.newPhrase, { onlyOrganization: true, positions: positionsMembersOnly });
    let phrase = recovery.newPhrase;
    let currentPassword = nextPassword;
    for (let cycle = 0; cycle < 2; cycle++) {
      const retainedPreferences = await capturedPreferences(client);
      const retainedStock = await capturedStock(client);
      const password = `Print-Repeat-Recovery-Test-${cycle}-2026!`;
      const draft = await recoveryDraft(client, tenant, phrase, password), plan = await recoveryPlan(client, draft);
      await commitRecovery(client, plan);
      await lockCryptoSession(); client.setToken(null);
      await signIn(client, { tenant, username: plan.username, password });
      currentPassword = password;
      assert.deepEqual(await capturedPreferences(client), retainedPreferences);
      assert.deepEqual(await capturedStock(client), retainedStock);
      const opened = createBusinessClient(client, { productDriver: testDriver, gaebProcessor: gaebTestProcessor });
      try {
        const navigation = await opened.access.read(); assert.ok(navigation); assert.equal(navigation.role("view:projects"), true);
        assert.deepEqual(await required(opened.query("settings.organization.get", undefined)), organizationBaseline);
        assert.deepEqual(await required(opened.query("settings.invoiceNumbering.get", undefined)), numberingBaseline);
        const restored = await required(opened.query("settings.documentTemplate.get", undefined));
        const view = await required(opened.query("personalization.gaebView.get", undefined));
        await required(opened.mutate("personalization.gaebView.set", { ...view, outlineWidth: 330 + cycle, zoom: 1.25 }));
        const reopened = createBusinessClient(client);
        try { assert.equal((await required(reopened.query("personalization.gaebView.get", undefined))).outlineWidth, 330 + cycle); }
        finally { reopened.dispose(); }
        assert.equal(restored.source, printBaseline.template.source);
        const { readTemplateResource } = await import("../app/lib/data/printTemplateData");
        for (const asset of restored.assets) {
          const resource = readTemplateResource(asset.downloadUrl!);
          assert.deepEqual(new Uint8Array(await (await opened.templates.blob(resource.id, resource.version)).arrayBuffer()), printBaseline.originals.get(asset.name));
        }
        if (positionsMembersOnly) {
          const positions = await required(opened.query("gaeb.positions.search", { query: "Erneutpositionsfreigegeben" }));
          assert.equal(positions.indexing, false); assert.equal(positions.items.length, 1);
          assert.equal(positions.items[0]!.shortText, "Erneutpositionsfreigegeben");
        }
      } finally { opened.dispose(); }
      await assert.rejects(() => recoveryDraft(client, tenant, phrase, password));
      phrase = draft.newPhrase;
    }
    console.log("Organization profiles, exact numbering settings and original print assets survived two seed-only recoveries; both replaced phrases were rejected immediately.");
    if (stockOnly) await testProtectedPriceImports(client, testDriver, currentPassword);
  } else {
  await testProtectedTools(client, projected.database, testDriver, nextPassword);
  await testProtectedProjectFiles(client, projected.database, newSubject, testDriver, nextPassword);
  await testProtectedCommercial(client, projected.database, newSubject, testDriver, commercialBaseline, addressCustomer.id, nextPassword);
  await testProtectedGaebDocuments(client, projected.database, testDriver, commercialBaseline);
  await testProtectedPositions(client, testDriver, gaebTestProcessor, projectFixture.id);
  if (!positionsOnly) {
  await testGaebDocumentWorkflows(client, projected.database, testDriver, gaebTestProcessor, nextPassword);
  await testCommercialWorkflows(client, testDriver, gaebTestProcessor, addressCustomer.id, nextPassword);
  await testContractAdoption(client, testDriver, gaebTestProcessor, addressCustomer.id, nextPassword);
  const liveBusiness = createBusinessClient(client, { endpoint: process.env.SORTSYS_LLM_TEST_OWNER ?? endpoint,
    productDriver: testDriver, openProducts: (raw, signal) => openProtectedProducts(raw, signal, testDriver) });
  try { await testLiveLlm(client, liveBusiness, testDriver); } finally { liveBusiness.dispose(); }
  await testLiveEvents(client, nextPassword, testDriver);
  await testLiveInvitations(client, testDriver, recovery.newPhrase);
  await testProtectedPriceImports(client, testDriver, nextPassword);
  }
  }
  }
} finally {await projected.database.close();}
assert.equal((await required(client.query("zerotrust.status",undefined,{strategy:"network-only"}))).phase,"enrolling","An intermediate archive must not activate the tenant prematurely");
await lockCryptoSession();await client.logout();
console.log("Browser migration code verified against the live API: interrupted copy, seed recovery, two key generations, lossless DuckDB projection and no premature activation.");
