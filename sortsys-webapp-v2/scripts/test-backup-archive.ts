import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createClient, type Client } from "@sortsys/v2-client";
import { digest, sign } from "@sortsys/zerotrust/sortsys";
import { sourceSql } from "./test-backup-initialization";
import { row } from "../app/lib/data/testing/businessRow.mjs";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { openPostgresBackup } from "../app/lib/backups/business";
import {
  archiveBackup,
  BackupSelectionMismatch,
  openBackupArchive,
} from "../app/lib/backups/archive";
import { adoptBackup } from "../app/lib/backups/adopt";
import { localBackupFiles } from "../app/lib/backups/files";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { readInitializationSource } from "../app/lib/crypto/initializationSource";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { required } from "../app/lib/data/protectedObjects";
import { loadFileContent } from "../app/lib/data/fileContent";
import { fileCollection, filePayload } from "../app/lib/data/projectFileData";
import { protectedCollection } from "../app/lib/data/protectedObjects";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import { allocateDeliveryNote } from "../app/lib/data/deliveryRegistry";
import { administratorContext } from "../app/lib/crypto/administration";
import { signIn } from "../app/lib/crypto/session";
import { deliveryAdoptionFrame } from "../app/lib/backups/deliveryNumbers";
import {
  oldScan,
  scanResult,
  scanSourceSql,
} from "../app/lib/data/testing/importHistory.mjs";
import {
  importHistoryCollection,
  prepareImportHistory,
} from "../app/lib/data/migrateImportHistory";
import { assistantPayload } from "../app/lib/data/privateLlm";
import { scanEntry } from "../app/lib/data/scanHistoryData";
import { importResult } from "../app/lib/data/imports";
import { publicId } from "../app/lib/data/products";
import { toolCollection } from "../app/lib/data/toolData";
import { invoiceXml } from "./test-live-billing";
import { enrollToolResponsibleMember } from "./test-native-tool-recovery";

async function resumeInBrowser(draft: OwnerDraft) {
  await new Promise<void>((resolve, reject) => {
    const browser = spawn("node", ["scripts/e2e/backupInitialization.browser.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SORTSYS_BACKUP_E2E_USER: draft.username,
        SORTSYS_BACKUP_E2E_PASSWORD: draft.password,
      },
    });
    browser.once("error", reject);
    browser.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Browser backup setup failed: ${signal ?? code}`));
    });
  });
}

export async function exerciseBackupArchive(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  transmissions: readonly string[][],
) {
  const signal = new AbortController().signal;
  const original = await readFile(
    new URL(
      "../../sortsys-api-v2/seed-assets/grundriss-erdgeschoss.pdf",
      import.meta.url,
    ),
  );
  const file = new File([original], "grundriss-erdgeschoss.pdf", {
    type: "application/pdf",
  });
  const xml = createGaebXml("84", "Private Innenputz 472915", "2026-11-10");
  const gaebFile = new File([xml], "innenputz.x84", {
    type: "application/xml",
  });
  const invoiceNumber = "ALT-4201";
  const archivedInvoiceXml = invoiceXml(
    "progress_invoice",
    "40.00",
    "47.60",
  ).replace(
    "<InvoiceNo>ENTWURF</InvoiceNo>",
    `<InvoiceNo>${invoiceNumber}</InvoiceNo>`,
  );
  const invoiceFile = new File([archivedInvoiceXml], `${invoiceNumber}.x89`, {
    type: "application/xml",
  });
  const originals = localBackupFiles([file, gaebFile, invoiceFile]);
  const history = {
    file: new File(
      [
        "COPY public.__tenants (name,password) FROM stdin;\nother-tenant\tPrivate old credential 219453\n\\.\n",
        scanSourceSql([
          oldScan(),
          oldScan({ id: "20", state: "queued", result: null }),
          oldScan({ id: "21", state: "matching", result: null, user_id: "89" }),
          oldScan({
            id: "22",
            state: "failed",
            result: null,
            error: "Private scan error 739182",
          }),
          oldScan({
            id: "23",
            state: "completed",
            result: "invalid original result 619243",
          }),
          oldScan({ id: "24", state: "ocr", result: null }),
          oldScan({
            id: "25",
            result: JSON.stringify(scanResult.deliveryNote),
          }),
          oldScan({
            tenant_name: "other-tenant",
            file_name: "Other tenant secret 742963.png",
          }),
        ]),
      ],
      "administration.sql",
      { type: "application/sql" },
    ),
    tenant: "old-tenant",
  };
  const sql = new Blob([
    sourceSql([
      row("users", {
        id: "87",
        username: draft.username,
        first_name: "Franz",
        last_name: "Altbestand",
        contract_type: "internal",
        ui_locale: "de",
        cost_per_hour: 73.25,
      }),
      row("users", {
        id: "88",
        username: "archived.employee",
        first_name: "Anna",
        contract_type: "internal",
        ui_locale: "en",
        deactivated_at: "2026-10-02T10:00:00.123456Z",
        archived_at: "2026-10-03T11:00:00.654321Z",
      }),
      row("users", {
        id: "89",
        username: "new.invitation",
        first_name: "Mara",
        contract_type: "external",
        ui_locale: "de",
      }),
      row("products", {
        id: "91",
        custom_id: "1",
        name: "Private Fassadenfarbe 741852",
        description: "Silikonharzfarbe 963741",
        base_unit: "l",
        other_units: "{}",
      }),
      row("projects", { id: "92", title: "Private Fenstersanierung 862451" }),
      row("tools", {
        id: "102",
        custom_id: "910901",
        brand: "Private Werkzeugdaten 651297",
        category: "Bohrhammer",
        purchase_price: 1287.25,
        usage_cost_per_day: 17.375,
      }),
      row("tool_trackings", {
        id: "103",
        tool_id: "102",
        project_id: "92",
        responsible_user_id: "89",
        started_by_user_id: "87",
        started_at: "2026-10-11T08:00:00Z",
        tool_usage_cost_per_day: 11.625,
      }),
      row("product_delivery_notes", {
        id: "94",
        auto_id: "840",
        project_id: "92",
        comment: "Private Schutzmateriallieferung 731946",
      }),
      row("product_delivery_special_records", {
        id: "95",
        note_id: "94",
        name: "Abdeckfolie",
        unit: "m²",
        amount: 3.5,
        price_per_unit: 19.75,
      }),
      row("project_files", {
        id: "93",
        project_id: "92",
        file_name: file.name,
        mime_type: "application/pdf",
        kind: "file",
        status: "uploaded",
        size_bytes: String(file.size),
        storage_bucket: "source-bucket",
        object_key: file.name,
        thumbnail_status: "none",
        text_extraction_status: "ready",
      }),
      row("commercial_cases", {
        id: "100",
        title: "Private Innenputz 472915",
        kind: "offer",
        status: "draft",
        scope_item_ids: "[]",
        currency: "EUR",
        net_amount: "0.00",
      }),
      row("commercial_documents", {
        id: "101",
        case_id: "100",
        purpose: "offer",
        phase: "84",
        file_name: gaebFile.name,
        object_key: gaebFile.name,
        size_bytes: String(gaebFile.size),
        net_amount: "0.00",
      }),
      row("commercial_cases", {
        id: "104",
        reference: "AU-4201",
        project_id: "92",
        title: "Übernommener Auftrag für Fensterarbeiten",
        kind: "offer",
        status: "accepted",
        scope_item_ids: "[]",
        currency: "EUR",
        net_amount: "240.00",
      }),
      row("commercial_cases", {
        id: "105",
        reference: "AZ-4201",
        project_id: "92",
        parent_case_id: "104",
        title: "Abschlag aus dem Altbestand",
        kind: "progress_invoice",
        status: "partially_paid",
        scope_item_ids: "[]",
        currency: "EUR",
        net_amount: "40.00",
      }),
      row("commercial_documents", {
        id: "106",
        case_id: "105",
        purpose: "invoice",
        phase: "89",
        file_name: invoiceFile.name,
        object_key: invoiceFile.name,
        size_bytes: String(invoiceFile.size),
        net_amount: "40.00",
        read_only: true,
      }),
      row("commercial_invoice_details", {
        case_id: "105",
        basis: "work",
        vat_rate: "19.00",
        invoice_number: invoiceNumber,
        invoice_date: "2026-11-12",
        due_date: "2026-11-26",
        service_start: "2026-11-12",
        service_end: "2026-11-12",
        total_net: "40.00",
        deducted_net: "0.00",
        gross_amount: "47.60",
      }),
      row("commercial_invoice_payments", {
        id: "107",
        case_id: "105",
        amount: "20.00",
        paid_on: "2026-11-13",
        reference: "Vergangener Abschlag aus der Buchhaltung",
        created_by_user_id: "87",
      }),
    ]),
  ]);
  const source = await openPostgresBackup(sql, signal, await duckDriver());
  function fileRequestsSince(start: number, procedure: string) {
    return transmissions
      .slice(start)
      .filter((paths) => paths.includes(`zerotrust.fileChunks.${procedure}`))
      .length;
  }
  try {
    const selection = {
      sql,
      database: source.database,
      rows: source.rows,
      files: originals,
      history,
    };
    const beforeBinding = transmissions.length;
    await assert.rejects(
      archiveBackup(owner, selection, signal, () => {
        throw new Error("Interrupted after binding the source selection");
      }),
      /Interrupted after binding the source selection/,
    );
    assert.equal((await readInitializationSource(peer, signal))?.source, null);

    const changedBytes = new Uint8Array(await file.arrayBuffer());
    changedBytes[0] = changedBytes[0]! ^ 1;
    const changedFile = new File([changedBytes], file.name, { type: file.type });
    const mismatches = [
      { ...selection, history: undefined },
      { ...selection, sql: new Blob([sql, "\n-- Different source bytes\n"]) },
      { ...selection, files: localBackupFiles([changedFile, gaebFile, invoiceFile]) },
    ];
    for (const attempt of mismatches) {
      await assert.rejects(
        archiveBackup(peer, attempt, signal),
        BackupSelectionMismatch,
      );
    }
    for (const procedure of ["findMany", "putMany", "getMany"]) {
      assert.equal(fileRequestsSince(beforeBinding, procedure), 0);
    }

    const initial = transmissions.length;
    await assert.rejects(
      archiveBackup(peer, selection, signal, (done, total) => {
        if (done === total) throw new Error("Interrupted after uploading the blocks");
      }),
      /Interrupted after uploading the blocks/,
    );
    // The originals travel together. SQL and the selected history each
    // use their own round of lookup, upload and readback.
    assert.equal(fileRequestsSince(initial, "findMany"), 3);
    assert.equal(fileRequestsSince(initial, "putMany"), 3);
    assert.equal(fileRequestsSince(initial, "getMany"), 3);
    const retry = transmissions.length;
    await archiveBackup(owner, selection, signal);
    assert.equal(fileRequestsSince(retry, "findMany"), 3);
    assert.equal(fileRequestsSince(retry, "putMany"), 0);
    assert.equal(fileRequestsSince(retry, "getMany"), 0);
    console.log(
      "Native backup archive: five one-block sources use 9 file-block HTTP requests on initial upload and 3 on resume",
    );
  } finally {
    await source.database.close();
  }
  const reopened = await openBackupArchive(peer, signal, await duckDriver());
  try {
    const recoveredFile = await reopened.files.read(
      { bucket: "source-bucket", key: file.name, size: file.size },
      signal,
    );
    assert.equal(
      await digest(new Uint8Array(await recoveredFile.arrayBuffer())),
      await digest(original),
    );
    assert.equal(reopened.rows, 17n);
    assert.equal(reopened.history?.tenant, history.tenant);
    assert.equal(reopened.history?.records.length, 7);
    assert.ok(
      reopened.history?.records.every(
        (record) => record.values.tenant_name === history.tenant,
      ),
    );
  } finally {
    await reopened.database.close();
  }
  await assert.rejects(
    () =>
      adoptBackup(owner, signal, {
        driver: duckDriver,
        onProgress(value) {
          if (value.step === "catalogues")
            throw new Error(
              "Simulated interrupted browser after personnel adoption",
            );
        },
      }),
    /Simulated interrupted browser/,
  );
  assert.equal(
    (await readInitializationSource(peer, signal))?.completion,
    null,
  );
  await assert.rejects(() => initializeTenant(peer, signal, duckDriver));
  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    await resumeInBrowser(draft);
  } else {
    await adoptBackup(peer, signal, {
      driver: duckDriver,
      processor: gaebTestProcessor,
    });
  }
  await initializeTenant(owner, signal, duckDriver);
  const business = createBusinessClient(peer, {
    productDriver: duckDriver,
    gaebProcessor: gaebTestProcessor,
  });
  try {
    const scans = await required(
      business.query("deliveryNotes.scan.list", undefined),
    );
    assert.equal(
      scans.length,
      6,
      "A second user's scan must stay in its own area",
    );
    assert.ok(
      scans.some((scan) => scan.id === "j" && scan.state === "completed"),
    );
    assert.match(scans.find((scan) => scan.id === "k")!.error!, /unterbrochen/);
    assert.equal(
      scans.find((scan) => scan.id === "m")!.error,
      "Private scan error 739182",
    );
    assert.match(
      scans.find((scan) => scan.id === "n")!.error!,
      /nicht verwendbar/,
    );
    assert.deepEqual(await importResult(peer, "j", signal), scanResult);
    assert.deepEqual(await importResult(peer, "p", signal), scanResult);
    await assert.rejects(importResult(peer, "k", signal), /unterbrochen/);
    const user = await required(business.query("users.get", { id: "2n" }));
    assert.equal(user.firstName, "Franz");
    assert.equal(user.costPerHour, 73.25);
    const archived = await required(
      peer.query(
        "zerotrust.members.status",
        { id: "2o" },
        { strategy: "network-only" },
      ),
    );
    assert.equal(archived.deactivatedMicros, "1790935200123456");
    assert.equal(archived.archivedMicros, "1791025200654321");
    const projects = await required(business.query("projects.list", {}));
    assert.ok(
      projects.some(
        (project) =>
          project.id === "2s" &&
          project.title === "Private Fenstersanierung 862451",
      ),
    );
    const products = await required(
      business.query("products.list", { search: "963741" }),
    );
    assert.equal(products.length, 1);
    const delivery = await required(
      business.query("deliveryNotes.get", { id: "2u" }),
    );
    assert.equal(delivery.autoId, 840);
    const tool = await required(business.query("tools.get", { id: "36" }));
    assert.equal(tool.brand, "Private Werkzeugdaten 651297");
    assert.equal(tool.purchasePrice, 1287.25);
    assert.equal(tool.usageCostPerDay, 17.375);
    assert.equal(tool.activeTrackingId, "37");
    const bookings = await required(
      business.query("tools.trackings.list", { toolId: "36" }),
    );
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0]!.id, "37");
    assert.equal(bookings[0]!.toolUsageCostPerDay, 11.625);
    const invoiceId = publicId("105");
    const invoice = await required(
      business.query("commercial.cases.get", { id: invoiceId }),
    );
    assert.equal(invoice.case.status, "partially_paid");
    assert.equal(invoice.invoice?.invoiceNumber, invoiceNumber);
    assert.equal(invoice.invoice?.paidAmount, "20.00");
    const chain = await required(
      business.query("commercial.invoices.context", {
        contractCaseId: publicId("104"),
      }),
    );
    assert.equal(chain.progressInvoices.length, 1);
    assert.equal(chain.progressInvoices[0]?.id, invoiceId);
    assert.equal(chain.progressInvoices[0]?.paidAmount, "20.00");
    const originalInvoice = await required(
      business.query("commercial.documents.get", {
        caseId: invoiceId,
        id: publicId("106"),
      }),
    );
    assert.equal(originalInvoice.xml, archivedInvoiceXml);
    assert.equal(originalInvoice.canEdit, false);
  } finally {
    business.dispose();
  }
  const coworkerArea = importHistoryCollection("user:2p");
  const coworkerHistory = await protectedCollection(
    owner,
    coworkerArea,
    signal,
  );
  try {
    const entries = await coworkerHistory.read();
    assert.equal(entries.length, 1);
    const entry = scanEntry(
      assistantPayload(entries[0]!.value, entries[0]!.envelope.object, "scan")
        .value,
    );
    assert.equal(entry.format, "sortsys-scan-v2");
    assert.equal(entry.legacy.state, "matching");
    assert.equal(entry.createdAt, "2026-11-12T10:00:00.123456Z");
  } finally {
    coworkerHistory.close();
  }
  const archivedSource = await openBackupArchive(
    peer,
    signal,
    await duckDriver(),
  );
  try {
    // An exact retry remains harmless, even after the source is sealed.
    await prepareImportHistory(
      peer,
      archivedSource.history!.records,
      `user:${draft.userId}`,
      draft.setup.authority.context!,
      signal,
    );
  } finally {
    await archivedSource.database.close();
  }
  const area = fileCollection("2s");
  const files = await protectedCollection(owner, area, signal);
  try {
    const saved = await files.read();
    assert.equal(saved.length, 1);
    const value = filePayload(saved[0]!.value, saved[0]!.envelope.object, "2s");
    assert.ok(value.original);
    const restored = await loadFileContent(
      owner,
      "2s",
      "2t",
      value.original,
      "application/pdf",
      signal,
    );
    assert.equal(
      await digest(new Uint8Array(await restored.arrayBuffer())),
      await digest(original),
    );
  } finally {
    files.close();
  }
  const documents = await commercialDocumentStore(
    owner,
    "commercial:34",
    signal,
  );
  try {
    const head = await documents.head("35");
    assert.ok(head);
    const restored = await documents.load(head, gaebTestProcessor);
    assert.equal(restored.complete, true);
    assert.equal(restored.xml, xml);
  } finally {
    documents.close();
  }
  const nextDelivery = await allocateDeliveryNote(
    peer,
    "2s",
    "backup_follow_up_01",
    signal,
  );
  assert.equal(nextDelivery.number, "841");
  const admin = await administratorContext(owner, signal);
  const status = await required(
    owner.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  const lateAdoption = {
    context: draft.setup.authority.context!,
    generation: status.generation,
    policyVersion: status.policyVersion,
    allocations: [{ id: "2u", projectId: "2s", number: "840" }],
  };
  const proof = await sign(
    admin.authority,
    deliveryAdoptionFrame(
      admin.account.tenant,
      `user:${admin.session.user.id}`,
      lateAdoption,
    ),
  );
  assert.ok(
    (
      await owner.mutate("zerotrust.deliveryNotes.adopt", {
        ...lateAdoption,
        proof,
      })
    )[1],
  );
  const endpoints = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS!);
  const member = createClient(endpoints[0], "archived-tool-responsibility");
  const credentials = {
    tenant: draft.link.tenant,
    username: draft.username,
    password: draft.password,
  };
  const memberPassword = "Archive-tool-responsibility-password-2026!";
  await enrollToolResponsibleMember(
    owner,
    member,
    { id: "2p", username: "new.invitation" },
    credentials,
    memberPassword,
  );
  const worker = createBusinessClient(member, { productDriver: duckDriver });
  try {
    const visible = await required(worker.query("tools.trackings.list", {}));
    assert.deepEqual(visible.map(({ id }) => id), ["37"]);
    assert.equal(visible[0]?.canReturnOwn, true);
    assert.equal(visible[0]?.toolUsageCostPerDay, null);
    assert.ok((await worker.query("tools.get", { id: "36" }))[1]);
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      const { exerciseToolResponsibilityBrowser } =
        await import("./test-tool-responsibility-browser");
      await exerciseToolResponsibilityBrowser({
        tenant: credentials.tenant,
        member: { username: "new.invitation", password: memberPassword },
        activeLabel: "Private Werkzeugdaten 651297",
        toolBrand: "Private Werkzeugdaten 651297",
        toolId: "36",
        bookingDomain: toolCollection("tool-tracking", "37", "master-data").domain,
        artifactName: "adopted-tool-return",
        selfReturn: true,
      }, async () => {});
    } else {
      await required(worker.mutate("tools.trackings.return", { trackingId: "37" }));
    }
    const remaining = await required(worker.query("tools.trackings.list", {}, {
      strategy: "network-only",
    }));
    assert.deepEqual(remaining, []);
  } finally {
    worker.dispose();
    member.setToken(null);
    await signIn(owner, credentials);
  }
  const ownerView = createBusinessClient(peer, { productDriver: duckDriver });
  try {
    assert.equal((await required(ownerView.query("tools.get", { id: "36" }))).available, true);
    const costs = await required(ownerView.query("projects.costs.get", { projectId: "2s" }));
    const usage = costs.toolTrackings.find(({ id }) => id === "37");
    assert.ok(usage?.endedAt instanceof Date);
    assert.equal(usage.endedByUserId, "2p");
    assert.equal(usage.toolUsageCostPerDay, 11.625);
  } finally {
    ownerView.dispose();
  }
  console.log("Adopted tool checkout: late invitation activates own return, with preserved project costs across API replicas");
  console.log(
    "Local backup archive verified: encrypted SQL and static PDF, source readback on a second replica, preserved user identities and lifecycle, interrupted adoption resumed from ciphertext, all business adapters, description search, exact attachment bytes and isolated per-user scan histories from the explicitly selected original tenant.",
  );
}
