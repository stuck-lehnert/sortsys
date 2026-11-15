import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { acceptVaultWithKey, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeCommercialAccess, changeCommercialCreation } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { commercialFacetPayload } from "../app/lib/data/commercialData";
import type { DuckDriver } from "../app/lib/data/database";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";

export async function testCommercialCaseAccess(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const memberId = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id, subject = `user:${memberId}`;
  await changeCommercialCreation(ownerClient, subject, true, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  let id: string;
  let business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    id = (await required(business.mutate("commercial.cases.create", { kind: "offer", title: "Angebot vom freigegebenen Mitarbeiter", scopeItemIds: [] }))).id;
    await required(business.mutate("commercial.cases.update", { id, title: "Angebot vom freigegebenen Mitarbeiter", customerId: null, counterpartyName: null, validUntil: null, notes: "Kalkulationsnotiz vor Rechteänderung" }));
    assert.equal((await required(business.query("commercial.cases.get", { id }))).case.notes, "Kalkulationsnotiz vor Rechteänderung");
  } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  await changeCommercialAccess(ownerClient, subject, id!, "calculation", "none", signal);
  await changeCommercialAccess(ownerClient, subject, id!, "offer-prices", "none", signal);
  const prices = commercialCollection(id!, "offer-prices"), priceStore = await protectedCollection(ownerClient, prices, signal);
  try {
    const original = (await priceStore.read(`${prices.prefix}case`))[0]!, value = commercialFacetPayload(original.value, id!, "offer-prices");
    value.rows.find(row => row.table === "commercial_cases")!.values.net_amount = "879.25";
    await priceStore.write([await priceStore.packet(original.envelope.object, value, original.envelope)]);
  } finally { priceStore.close(); }
  business = createBusinessClient(ownerClient, { productDriver: driver });
  try { await required(business.mutate("commercial.cases.update", { id: id!, title: "Angebot vom freigegebenen Mitarbeiter", customerId: null, counterpartyName: null, validUntil: null, notes: "Neue interne Kalkulationsnotiz nach Entzug" })); }
  finally { business.dispose(); }
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const openedKeys: string[] = [], requests: unknown[] = [];
  const observed: Client = { ...memberClient, query: ((path, input, options) => {
    requests.push({ path, input }); if (path === "zerotrust.keys.get") openedKeys.push((input as { domain: string }).domain); return memberClient.query(path, input, options);
  }) as Client["query"], mutate: ((path, input, options) => { requests.push({ path, input }); return memberClient.mutate(path, input, options); }) as Client["mutate"] };
  business = createBusinessClient(observed, { productDriver: driver });
  try {
    const partial = await required(business.query("commercial.cases.get", { id: id! }));
    assert.equal(partial.case.notes, null); assert.equal(partial.case.netAmount, null); assert.equal(partial.canManage, true);
    await required(business.mutate("commercial.cases.update", { id: id!, title: "Stammdaten ohne Preisfreigabe geändert", customerId: null, counterpartyName: null, validUntil: null, notes: null }));
    assert.ok((await business.mutate("commercial.cases.update", { id: id!, title: "Unzulässige Notizänderung", customerId: null, counterpartyName: null, validUntil: null, notes: "Versuch ohne Kalkulationsschlüssel" }))[1]);
    assert.equal((await required(business.query("commercial.cases.list", { search: "Stammdaten ohne Preisfreigabe" }))).some(value => value.id === id), true);
    assert.equal(openedKeys.includes(prices.domain), false); assert.equal(openedKeys.includes(commercialCollection(id!, "calculation").domain), false);
    for (const canary of ["Stammdaten ohne Preisfreigabe", "Versuch ohne Kalkulationsschlüssel"]) assert.equal(JSON.stringify(requests).includes(canary), false);
  } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  business = createBusinessClient(ownerClient, { productDriver: driver });
  try {
    const original = await required(business.query("commercial.cases.get", { id: id! }));
    assert.equal(original.case.title, "Stammdaten ohne Preisfreigabe geändert");
    assert.equal(original.case.netAmount, "879.25"); assert.equal(original.case.notes, "Neue interne Kalkulationsnotiz nach Entzug");
  } finally { business.dispose(); }
  await changeCommercialCreation(ownerClient, subject, false, signal);
  console.log("Commercial case access verified: ordinary delegated creator, independently revoked price/note keys, master-data editing without private keys and preservation of unseen prices/notes.");
}
