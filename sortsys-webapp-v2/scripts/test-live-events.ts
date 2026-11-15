import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient, type Client } from "@sortsys/v2-client";
import { bytes, digest, frame, sign, signPolicy, policyFrame, verify } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, signIn, trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { llmActivity } from "../app/lib/llmActivity";
import { openAuthority } from "../app/lib/crypto/setup";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openProtectedProducts } from "../app/lib/data/products";
import type { DuckDriver } from "../app/lib/data/database";
import type { EncryptedChange } from "../app/lib/data/events";
import { required } from "../app/lib/data/protectedObjects";
import type { GaebViewPreferences } from "@sortsys/gaeb";

export async function until(test: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 15000;
  while (!await test()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await Bun.sleep(20); }
}
export async function testLiveEvents(ownerClient: Client, password: string, driver: () => Promise<DuckDriver>) {
  const owner = unlockedAccount()!, peer = process.env.SORTSYS_LLM_TEST_PEER!, endpoint = process.env.SORTSYS_MIGRATION_TEST_API!;
  const observerRaw = createClient(peer, "encrypted-event-integration");
  await signIn(observerRaw, { tenant: owner.tenant, username: owner.username, password });
  const identity = unlockedAccount()!;
  const ticket = await required(ownerClient.mutate("zerotrust.events.open", undefined));
  let captured = "";
  async function probe(replay = false): Promise<boolean> {
    const socket = new WebSocket(peer.replace(/^http/, "ws") + "/zerotrust/events");
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ready: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.onmessage = null; socket.onclose = null; socket.close(); resolve(ready); };
      const timer = setTimeout(() => { socket.close(); reject(new Error("Event admission timed out")); }, 10000);
      socket.onclose = () => finish(false); socket.onerror = () => finish(false);
      socket.onmessage = event => { void (async () => {
        const value = JSON.parse(event.data);
        if (value.type === "challenge") {
          const proof = replay ? captured : await sign(identity.identity.signingKey.privateKey, frame("sortsys/events-browser/v1", [identity.tenant, ticket.subject, ticket.generation, await digest(bytes(ticket.ticket)), value.nonce]));
          if (!replay) captured = proof;
          socket.send(JSON.stringify({ ticket: ticket.ticket, proof }));
        } else if (value.type === "ready") finish(true);
        else if (value.type === "revoked") finish(false);
      })().catch(reject); };
    });
  }
  assert.equal(await probe(), true, "A ticket from API one must admit its owner on API two");
  assert.equal(await probe(true), false, "A captured proof must not authenticate a new socket challenge");
  const changes: EncryptedChange[][] = [[], []], catalogues: { id: string; name: string }[][][] = [[], []], titles: string[][] = [];
  const count = [0, 0], opens = [0, 0], resetRows = [0, 0];
  const originalSocket = globalThis.WebSocket, sockets: WebSocket[] = [];
  const transport: { type?: string; fingerprintLength?: number; code?: number }[] = [];
  globalThis.WebSocket = new Proxy(originalSocket, { construct(target, args) {
    const socket = Reflect.construct(target, args) as WebSocket; sockets.push(socket);
    socket.addEventListener("message", event => { try { const value = JSON.parse(event.data); transport.push({ type: value.type, fingerprintLength: typeof value.fingerprint === "string" ? value.fingerprint.length : undefined }); } catch {} });
    socket.addEventListener("close", event => transport.push({ code: event.code })); return socket;
  } });
  let workSignal: AbortSignal | null = null;
  const work = llmActivity.run("chat", "event-access-test", signal => { workSignal = signal; return new Promise<void>(() => {}); })
    .then(() => false, error => error?.name === "AbortError");
  await until(() => workSignal !== null, "authorized work started before event admission");
  const observers = changes.map((events, index) => createBusinessClient(observerRaw, { endpoint: peer, realtime: true,
    onRemoteChange: event => { events.push(event); if (event.all || event.reset) resetRows[index] = catalogues[index].length; }, productDriver: driver,
    openProducts: (client, signal) => { opens[index]++; return openProtectedProducts(client, signal, async () => { count[index]++; return driver(); }); } }));
  const sender = createBusinessClient(ownerClient, { endpoint, productDriver: driver, openProducts: (client, signal) => openProtectedProducts(client, signal, driver) });
  const subscriptions = observers.map((client, index) => client.streamQuery("products.list", { search: "Ereignisabgleich" }).subscribe(([rows, error]) => { if (!error && rows) catalogues[index].push(rows); }));
  const menuRights: boolean[][] = [[], []];
  const menuSubscriptions: (() => void)[] = [];
  for (const [index, observer] of observers.entries()) {
    const update = () => { const context = observer.access.context(); void observer.access.read().then(view => {
      if (!context.aborted && observer.access.context() === context && view) menuRights[index].push(view.can("catalog:events-test-own", "master-data", "read"));
    }).catch(() => undefined); };
    menuSubscriptions.push(observer.access.subscribe(update)); update();
  }
  const organizationNames: (string | null)[][] = [[], []];
  const templateSources: (string | null)[][] = [[], []];
  const preferenceViews: GaebViewPreferences[][] = [[], []];
  const supplierNames: string[][] = [[], []], priceValues: number[][] = [[], []];
  let liveSupplier = "", livePrice = "";
  for (const [index, observer] of observers.entries()) subscriptions.push(observer.streamQuery("settings.organization.get", undefined).subscribe(([profile, error]) => {
    if (!error && profile) organizationNames[index].push(profile.companyName);
  }));
  for (const [index, observer] of observers.entries()) subscriptions.push(observer.streamQuery("settings.documentTemplate.get", undefined).subscribe(([template, error]) => {
    if (!error && template) templateSources[index].push(template.source);
  }));
  for (const [index, observer] of observers.entries()) subscriptions.push(observer.streamQuery("personalization.gaebView.get", undefined).subscribe(([view, error]) => {
    if (!error && view) preferenceViews[index].push(view);
  }));
  for (const [index, observer] of observers.entries()) subscriptions.push(observer.streamQuery("products.vendors.list", {}).subscribe(([rows, error]) => {
    if (!error && rows) supplierNames[index].push(rows.find(row => row.id === liveSupplier)?.name ?? "");
  }));
  for (const [index, observer] of observers.entries()) subscriptions.push(observer.streamQuery("products.priceRecords.list", {}).subscribe(([rows, error]) => {
    if (!error && rows) priceValues[index].push(rows.find(row => row.id === livePrice)?.price ?? -1);
  }));
  subscriptions.push(observers[0].streamQuery("llm.chats.list", undefined).subscribe(([chats, error]) => { if (!error && chats) titles.push(chats.map(chat => chat.title)); }));
  const dsn = process.env.SORTSYS_MIGRATION_TEST_PG_DSN;
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1" || !dsn || !new URL(dsn).hostname.startsWith("sortsys-test-api-postgres-")) throw new Error("Disposable event fixture required");
  const database = new SQL(dsn);
  const listeners = async () => Number((await database`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN%sortsys_zerotrust%'`)[0].n);
  let stage = "initial synchronization";
  try {
    await until(() => changes.every(events => events.some(event => event.all)) && catalogues.every(rows => rows.length > 0) && titles.length > 0, "both observers ready");
    assert.equal(workSignal!.aborted, false, "Initial event admission must not interrupt authorized work");
    assert.equal(await listeners(), 1, "Two sockets on the same API share one tenant listener");
    stage = "organization settings across API instances";
    await until(() => organizationNames.every(names => names.length > 0), "both organization caches ready");
    const organization = await required(sender.query("settings.organization.get", undefined));
    const companyName = "Organisationsanschrift über unabhängige API-Instanzen";
    await required(sender.mutate("settings.organization.set", { ...organization, companyName }));
    await until(() => organizationNames.every(names => names.at(-1) === companyName), "remote organization change");
    await required(sender.mutate("settings.organization.set", organization));
    await until(() => organizationNames.every(names => names.at(-1) === organization.companyName), "remote organization restoration");
    stage = "print templates across API instances";
    await until(() => templateSources.every(sources => sources.length > 0), "both print caches ready");
    const template = await required(sender.query("settings.documentTemplate.get", undefined)); assert.ok(template.source);
    const templateSource = template.source + "\n// Druckvorlage über unabhängige API-Instanzen\n";
    const updatedTemplate = await required(sender.mutate("settings.documentTemplate.set", { source: templateSource, expectedRevision: template.revision }));
    await until(() => templateSources.every(sources => sources.at(-1) === templateSource), "remote print template change");
    await required(sender.mutate("settings.documentTemplate.set", { source: template.source, expectedRevision: updatedTemplate.revision }));
    await until(() => templateSources.every(sources => sources.at(-1) === template.source), "remote print template restoration");
    stage = "personal preferences across API instances";
    await until(() => preferenceViews.every(views => views.length > 0), "both personal preference caches ready");
    const originalView = await required(sender.query("personalization.gaebView.get", undefined));
    const changedView = { ...originalView, showFields: !originalView.showFields, outlineWidth: 543, zoom: 1.875 };
    await required(sender.mutate("personalization.gaebView.set", changedView));
    await until(() => preferenceViews.every(views => JSON.stringify(views.at(-1)) === JSON.stringify(changedView)), "remote personal preference change");
    await required(sender.mutate("personalization.gaebView.set", originalView));
    await until(() => preferenceViews.every(views => JSON.stringify(views.at(-1)) === JSON.stringify(originalView)), "remote personal preference restoration");
    const name = "Ereignisabgleich über unabhängige API-Instanzen", description = "Ereignisabgleich nur im verschlüsselten Katalog";
    stage = "catalogue creation";
    const customId = await required(sender.query("products.suggestNextCustomId", undefined));
    const created = await required(sender.mutate("products.create", { customId, name, description, baseUnit: "m" }));
    await until(() => catalogues.every(rows => rows.at(-1)?.some(row => row.id === created.id && row.name === name)), "remote catalogue creation");
    const renamed = name + " nach Änderung";
    await required(sender.mutate("products.update", { id: created.id, data: { name: renamed } }));
    await until(() => catalogues.every(rows => rows.at(-1)?.some(row => row.id === created.id && row.name === renamed)), "remote catalogue update");
    stage = "supplier and price updates across API instances";
    await until(() => supplierNames.every(values => values.length > 0) && priceValues.every(values => values.length > 0), "both stock subscriptions ready");
    const beforeStock = [...count], supplierName = "Lieferantenabgleich über unabhängige API-Instanzen";
    liveSupplier = (await required(sender.mutate("products.vendors.create", { name: supplierName, description: "Nur verschlüsselt übermitteln" }))).id;
    await required(sender.mutate("products.vendors.update", { id: liveSupplier, data: { name: supplierName + " geändert" } }));
    await until(() => supplierNames.every(values => values.at(-1) === supplierName + " geändert"), "remote supplier update");
    livePrice = (await required(sender.mutate("products.priceRecords.create", { productId: created.id, vendorId: liveSupplier,
      pricePerBaseUnit: 78321.4567, timestamp: new Date("2026-11-11T12:34:56Z"), isRealPurchase: false }))).id;
    await required(sender.mutate("products.priceRecords.update", { id: livePrice, data: { pricePerBaseUnit: 87321.6543 } }));
    await until(() => priceValues.every(values => values.at(-1) === 87321.6543), "remote price update");
    await required(sender.mutate("products.priceRecords.delete", { id: livePrice }));
    await until(() => priceValues.every(values => values.at(-1) === -1), "remote price deletion");
    assert.deepEqual(count, beforeStock, "Supplier and price events must not rebuild catalogue databases");
    stage = "browser reconnect";
    const beforeReconnect = changes.map(events => events.filter(event => event.all).length);
    sockets[0].close();
    const afterReconnect = renamed + " nach Socket-Wechsel";
    await required(sender.mutate("products.update", { id: created.id, data: { name: afterReconnect } }));
    // Concurrent admission can create either observer's socket first. Verify
    // the closed connection resynchronizes without assuming that creation order.
    await until(() => changes.some((events, index) => events.filter(event => event.all).length > beforeReconnect[index]) && catalogues.every((rows, index) => rows.length > resetRows[index]
      && rows.at(-1)?.some(row => row.id === created.id && row.name === afterReconnect)), "browser reconnect resnapshot");
    assert.equal(await listeners(), 1);
    stage = "shared listener reconnect";
    const resetCounts = changes.map(events => events.filter(event => event.all).length);
    await database`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'LISTEN%sortsys_zerotrust%'`;
    const afterDatabaseReconnect = renamed + " nach Listener-Wechsel";
    await required(sender.mutate("products.update", { id: created.id, data: { name: afterDatabaseReconnect } }));
    await until(async () => changes.every((events, index) => events.filter(event => event.all).length > resetCounts[index])
      && catalogues.every((rows, index) => rows.length > resetRows[index] && rows.at(-1)?.some(row => row.id === created.id && row.name === afterDatabaseReconnect))
      && await listeners() === 1, "shared listener reconnect resnapshot");
    assert.equal(workSignal!.aborted, false, "Transport reconnects with unchanged rights must not interrupt authorized work");
    stage = "unrelated permission changes";
    const { signature, ...originalPolicy } = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
    const history = await trustedHistory(ownerClient), status = await required(ownerClient.query("zerotrust.status", undefined, { strategy: "network-only" }));
    await verify(history.authority(history.current.generation), signature, policyFrame(originalPolicy));
    const authority = await openAuthority(ownerClient, status.profile), beforeOpens = [...opens];
    for (const rules of [[...originalPolicy.rules, { subject: "user:2", scope: "catalog:events-test-unrelated", facet: "master-data" as const, actions: ["read" as const], effect: "allow" as const }], originalPolicy.rules]) {
      const current = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
      const before = changes.map(events => events.length);
      await required(ownerClient.mutate("zerotrust.policy.replace", await signPolicy({ tenant: identity.tenant, version: (BigInt(current.version) + 1n).toString(), rules }, authority)));
      await until(() => changes.every((events, index) => events.slice(before[index]).some(event => event.all && event.control))
        && catalogues.every((rows, index) => rows.length > resetRows[index]), "unrelated policy refresh");
      assert.equal(changes.some((events, index) => events.slice(before[index]).some(event => event.reset)), false,
        "Changing another subject must not abort this user's active document/chat context");
    }
    assert.deepEqual(opens, beforeOpens, "Unchanged own rights retain their open stores while refreshing policy versions");
    assert.equal(workSignal!.aborted, false, "Another user's rights change must not interrupt authorized work");
    stage = "own permission gain and loss";
    await until(() => menuRights.every(values => values.length > 0), "both menu projections ready");
    const beforeGain = changes.map(events => events.length);
    const current = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
    const ownRule = { subject: ticket.subject, scope: "catalog:events-test-own", facet: "master-data" as const, actions: ["read" as const], effect: "allow" as const };
    await required(ownerClient.mutate("zerotrust.policy.replace", await signPolicy({ tenant: identity.tenant, version: (BigInt(current.version) + 1n).toString(), rules: [...originalPolicy.rules, ownRule] }, authority)));
    await until(() => changes.every((events, index) => events.slice(beforeGain[index]).some(event => event.all && event.control))
      && catalogues.every((rows, index) => rows.length > resetRows[index]), "own additional right");
    assert.equal(changes.some((events, index) => events.slice(beforeGain[index]).some(event => event.reset)), false);
    assert.deepEqual(opens, beforeOpens, "Additional own rights must preserve an already authorized context");
    assert.equal(workSignal!.aborted, false, "Additional own rights must not interrupt authorized work");
    await until(() => menuRights.every(values => values.at(-1) === true), "verified menus gain the new right across API instances");
    const beforeLoss = changes.map(events => events.length);
    await required(ownerClient.mutate("zerotrust.policy.replace", await signPolicy({ tenant: identity.tenant, version: (BigInt(current.version) + 2n).toString(), rules: originalPolicy.rules }, authority)));
    await until(() => changes.every((events, index) => events.slice(beforeLoss[index]).some(event => event.reset))
      && catalogues.every((rows, index) => rows.length > resetRows[index]), "revoked own right resets access contexts");
    assert.ok(opens.every((value, index) => value > beforeOpens[index]));
    assert.equal(await work, true, "Revoked own rights must interrupt live work using the old access context");
    await until(() => menuRights.every(values => values.at(-1) === false), "verified menus remove revoked rights across API instances");

    stage = "private chat synchronization";
    const beforeChat = [...count];
    const title = "Privater Chat über den gemeinsamen Ereigniskanal";
    await required(sender.mutate("llm.chats.create", { title }));
    await until(() => titles.at(-1)?.includes(title) ?? false, "remote private chat");
    assert.deepEqual(count, beforeChat, "Private chat events must not rebuild catalogue databases");
    stage = "remote customer and contact synchronization";
    const addressRows: { id: string; name: string }[][] = [], contactRows: { id: string; firstName: string | null }[][] = [];
    subscriptions.push(observers[0].streamQuery("customers.list", { search: "Mehrinstanzadresskunde" }).subscribe(([rows, error]) => { if (!error && rows) addressRows.push(rows); }));
    subscriptions.push(observers[0].streamQuery("contacts.list", { search: "Mehrinstanzkontakt" }).subscribe(([rows, error]) => { if (!error && rows) contactRows.push(rows); }));
    await until(() => addressRows.length > 0 && contactRows.length > 0, "directory subscriptions ready");
    const customer = await required(sender.mutate("customers.create", { name: "Mehrinstanzadresskunde nur im verschlüsselten Speicher" }));
    const contact = await required(sender.mutate("contacts.create", { firstName: "Mehrinstanzkontakt" }));
    await until(() => !!addressRows.at(-1)?.some(row => row.id === customer.id) && !!contactRows.at(-1)?.some(row => row.id === contact.id), "remote directory creation");
    await required(sender.mutate("customers.update", { id: customer.id, data: { name: "Mehrinstanzadresskunde geändert" } }));
    await until(() => !!addressRows.at(-1)?.some(row => row.id === customer.id && row.name === "Mehrinstanzadresskunde geändert"), "remote customer update");
    await required(sender.mutate("contacts.delete", { id: contact.id }));
    await until(() => !contactRows.at(-1)?.some(row => row.id === contact.id), "remote contact deletion");
    stage = "remote per-project synchronization";
    const projectRows: { id: string; title: string }[][] = [];
    subscriptions.push(observers[0].streamQuery("projects.list", { search: "Mehrinstanzprojekt" }).subscribe(([rows, error]) => { if (!error && rows) projectRows.push(rows); }));
    await until(() => projectRows.length > 0, "project subscription ready");
    const project = await required(sender.mutate("projects.create", { title: "Mehrinstanzprojekt nur im verschlüsselten Speicher" }));
    await until(() => !!projectRows.at(-1)?.some(row => row.id === project.id), "remote project creation");
    await required(sender.mutate("projects.update", { id: project.id, data: { title: "Mehrinstanzprojekt geändert" } }));
    await until(() => !!projectRows.at(-1)?.some(row => row.id === project.id && row.title === "Mehrinstanzprojekt geändert"), "remote project update");
    await required(sender.mutate("projects.delete", { id: project.id }));
    await until(() => !projectRows.at(-1)?.some(row => row.id === project.id), "remote project deletion");
    assert.deepEqual(count, beforeChat, "Directory events must not rebuild catalogue databases");
    for (const canary of [name, description, title, "Mehrinstanzadresskunde", "Mehrinstanzkontakt", "Mehrinstanzprojekt"]) assert.equal(JSON.stringify(changes).includes(canary), false);
    for (const canary of ["Lieferantenabgleich", "87321.6543", "78321.4567"]) assert.equal(JSON.stringify(changes).includes(canary), false);
    assert.ok(changes.every(events => events.some(event => typeof event.domains["catalog:products:master-data"] === "string")));
  } catch (cause) {
    console.error("Event synchronization diagnostics", { stage, changes, rows: catalogues.map(rows => rows.length), resetRows,
      sockets: sockets.map(socket => socket.readyState), transport });
    throw new Error(`Encrypted events failed at ${stage}`, { cause });
  }
  finally {
    llmActivity.cancelAll();
    for (const subscription of subscriptions) subscription.unsubscribe();
    for (const unsubscribe of menuSubscriptions) unsubscribe();
    for (const observer of observers) observer.dispose(); sender.dispose(); globalThis.WebSocket = originalSocket;
    await until(async () => await listeners() === 0, "tenant listener released after last observer");
    await database.close(); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  }
  console.log("Encrypted events verified: cross-instance admission, challenge replay denial, one shared tenant listener, live catalogue/chat/preference/supplier/price updates without business polling or plaintext events, targeted refresh, authorized-work continuity, revocation cancellation and listener cleanup.");
}
