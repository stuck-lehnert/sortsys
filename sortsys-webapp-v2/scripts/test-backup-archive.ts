import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Client } from "@sortsys/v2-client";
import { digest, sign } from "@sortsys/zerotrust/sortsys";
import { sourceSql } from "./test-backup-initialization";
import { row } from "../app/lib/data/testing/businessRow.mjs";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { openPostgresBackup } from "../app/lib/backups/business";
import { archiveBackup, openBackupArchive } from "../app/lib/backups/archive";
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
import { deliveryAdoptionFrame } from "../app/lib/backups/deliveryNumbers";

export async function exerciseBackupArchive(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
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
    ]),
  ]);
  const source = await openPostgresBackup(sql, signal, await duckDriver());
  try {
    await archiveBackup(
      owner,
      {
        sql,
        database: source.database,
        rows: source.rows,
        files: localBackupFiles([file, gaebFile]),
      },
      signal,
    );
    await archiveBackup(
      peer,
      {
        sql,
        database: source.database,
        rows: source.rows,
        files: localBackupFiles([file, gaebFile]),
      },
      signal,
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
    assert.equal(reopened.rows, 10n);
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
  await adoptBackup(peer, signal, {
    driver: duckDriver,
    processor: gaebTestProcessor,
  });
  await initializeTenant(owner, signal, duckDriver);
  const business = createBusinessClient(peer, { productDriver: duckDriver });
  try {
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
  } finally {
    business.dispose();
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
  console.log(
    "Local backup archive verified: encrypted SQL and static PDF, source readback on a second replica, preserved user identities and lifecycle, interrupted adoption resumed from ciphertext, all business adapters, description search and exact attachment bytes.",
  );
}
