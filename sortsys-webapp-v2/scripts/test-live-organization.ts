import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import type { BusinessDatabase } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { prepareOrganization } from "../app/lib/data/migrateOrganization";
import { NUMBERING_COLLECTION } from "../app/lib/data/organizationData";
import { required } from "../app/lib/data/protectedObjects";
import { OrganizationEditConflict } from "../app/lib/data/organization";

export async function testProtectedOrganization(client: Client, source: BusinessDatabase, subject: string,
  profile: QueryResult<"settings.organization.get">, numbering: QueryResult<"settings.invoiceNumbering.get">) {
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("Disposable test stack only");
  const signal = new AbortController().signal;
  await prepareOrganization(client, source, subject, signal);
  await prepareOrganization(client, source, subject, signal); // Verified resume, no duplicate settings.
  const sent: { path: string; input: unknown }[] = [], keys: string[] = [];
  let discardWrite = false, rendezvous: (() => void) | null = null, arrived = 0;
  let bothReading: Promise<void> | null = null;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input });
      if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain);
      return client.query(path, input, options);
    }) as Client["query"],
    mutate: (async (path, input, options) => { sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discardWrite) return [{ success: true, heads: [] }, null];
      if (path === "zerotrust.objects.batch" && bothReading) { if (++arrived === 2) rendezvous!(); await bothReading; }
      return client.mutate(path, input, options);
    }) as Client["mutate"],
  };
  // Independent browser transports must race at the server. Facades sharing
  // one transport now correctly serialize through their common data runtime.
  const business = createBusinessClient(observed), concurrent = createBusinessClient({ ...observed });
  try {
    assert.deepEqual(await required(business.query("settings.organization.get", undefined)), profile);
    assert.equal(keys.includes(NUMBERING_COLLECTION.domain), false, "Reading the sender's address must not open the billing key");
    assert.deepEqual(await required(business.query("settings.invoiceNumbering.get", undefined)), numbering);
    const changed = { ...profile, companyName: "Privater Organisationsname Test 48931", address: { streetAddress: "Geheime Anschrift 48931", city: "Bamberg", zip: "96047", country: "DE" } };
    const writes = sent.filter(row => row.path === "zerotrust.objects.batch").length;
    assert.ok((await business.mutate("settings.organization.set", { ...changed, companyName: " " }))[1]);
    assert.equal(sent.filter(row => row.path === "zerotrust.objects.batch").length, writes);
    discardWrite = true;
    assert.ok((await business.mutate("settings.organization.set", changed))[1], "A forged success without durable ciphertext must not acknowledge the edit");
    discardWrite = false;
    assert.deepEqual(await required(business.query("settings.organization.get", undefined)), profile);
    await required(business.mutate("settings.organization.set", changed));
    assert.deepEqual(await required(business.query("settings.organization.get", undefined)), changed);
    for (const scheme of ["sequential", "dateSeparated", "dateCompact", "projectLocal", "projectGlobal"] as const) {
      const config = { scheme, startNumber: "9223372036854775807" };
      await required(business.mutate("settings.invoiceNumbering.set", config));
      assert.deepEqual(await required(business.query("settings.invoiceNumbering.get", undefined)), config);
    }
    for (const selected of ["profile", "numbering"] as const) {
      if (selected === "profile") {
        const older = await business.organization.profile(), newer = await business.organization.profile();
        const remote = { ...changed, companyName: "Stand einer zweiten Formularansicht" };
        await newer.save(remote);
        await business.invalidate("settings.organization.get");
        assert.deepEqual(await required(business.query("settings.organization.get", undefined)), remote);
        await assert.rejects(() => older.save(changed), OrganizationEditConflict);
        await assert.rejects(() => older.save(changed), OrganizationEditConflict);
        await newer.save(changed); // Confirmed saves alone advance this form's base.
      } else {
        const older = await business.organization.numbering(), newer = await concurrent.organization.numbering();
        const remote = { scheme: "dateCompact" as const, startNumber: "987654321012345678" };
        await newer.save(remote);
        await business.invalidate("settings.invoiceNumbering.get");
        await required(business.query("settings.invoiceNumbering.get", undefined));
        await assert.rejects(() => older.save(numbering), OrganizationEditConflict);
        await newer.save(numbering);
      }
    }
    // Both browsers seal from the same public collection head. One commit
    // must lose instead of silently overwriting the other administrator.
    bothReading = new Promise(resolve => { rendezvous = resolve; });
    const release = setTimeout(() => { rendezvous?.(); }, 10000);
    const candidates = [{ ...changed, companyName: "Parallele Organisation A 48931" }, { ...changed, companyName: "Parallele Organisation B 48931" }];
    let outcomes: Awaited<ReturnType<typeof business.mutate>>[];
    try { outcomes = await Promise.all([business.mutate("settings.organization.set", candidates[0]!), concurrent.mutate("settings.organization.set", candidates[1]!)]); }
    finally { clearTimeout(release); }
    bothReading = null;
    assert.equal(arrived, 2, "Both writers must reach the shared-head barrier");
    assert.equal(outcomes.filter(row => row[1] === null).length, 1, "Exactly one current-head update can commit");
    await business.invalidate("settings.organization.get");
    assert.deepEqual(await required(business.query("settings.organization.get", undefined)), candidates[outcomes.findIndex(row => row[1] === null)]);
    await required(business.mutate("settings.organization.set", profile));
    await required(business.mutate("settings.invoiceNumbering.set", numbering));
    assert.equal(sent.some(row => row.path.startsWith("settings.")), false, "Business settings may never fall back to the plaintext API");
    const wire = JSON.stringify(sent);
    for (const secret of ["Geheime Anschrift 48931", "Privater Organisationsname Test 48931", "9223372036854775807", "Parallele Organisation A 48931"]) assert.equal(wire.includes(secret), false);
    const ending = createBusinessClient(observed);
    const closedEdit = await ending.organization.profile();
    const pending = ending.query("settings.organization.get", undefined); ending.dispose();
    assert.ok((await pending)[1], "Disposed account contexts cannot return decrypted settings");
    await assert.rejects(() => closedEdit.save(profile), "A form lease must not cross its account lifetime");
  } finally { business.dispose(); concurrent.dispose(); }
  console.log("Encrypted organization address and invoice settings: verified source conversion, exact counters, read-back checks, CAS conflict and no plaintext settings RPC.");
}
