import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  attestMigrationOrigin,
  sign,
  signInitializationSource,
} from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { row, sourceSql } from "../app/lib/data/testing/businessRow.mjs";
export { sourceSql } from "../app/lib/data/testing/businessRow.mjs";
import { openPostgresBackup } from "../app/lib/backups/business";
import { prepareProductCatalog } from "../app/lib/data/migrateProducts";
import { preparePersonnel } from "../app/lib/data/migratePersonnel";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import {
  initializeTenant,
  initializationFrame,
} from "../app/lib/crypto/initializeTenant";
import { readInitializationSource } from "../app/lib/crypto/initializationSource";
import { openAuthority } from "../app/lib/crypto/setup";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";

export async function exerciseBackupInitialization(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
) {
  const signal = new AbortController().signal;
  const context = draft.setup.authority.context!;
  const subject = `user:${draft.userId}`;
  assert.equal(draft.userId, "2n");
  const authority = await openAuthority(owner, draft.setup);
  assert.equal((await readInitializationSource(peer, signal))?.source, null);
  await assert.rejects(() => initializeTenant(peer, signal, duckDriver));
  assert.deepEqual(
    await required(owner.query("zerotrust.domains.list", undefined)),
    [],
  );
  const initial = {
    tenant: draft.link.tenant,
    generation: "1",
    subject,
    policyVersion: "1",
    domains: ["testing:missing:master-data"],
    objects: ["missing"],
  };
  assert.ok(
    (
      await peer.mutate("zerotrust.setup.complete", {
        ...initial,
        signature: await sign(authority, initializationFrame(initial)),
      })
    )[1],
  );

  const area = {
    domain: `${context}:master-data`,
    scope: context,
    facet: "master-data" as const,
    prefix: `${context}:`,
  };
  await provisionOwnedCollections(owner, subject, [area], signal);
  let archive = await protectedCollection(owner, area, signal);
  try {
    await archive.read();
    const manifest = await archive.packet(`${context}:manifest`, {
      format: "sortsys-backup-source-v1",
      source: "private-local-sql-fixture",
    });
    await archive.write([manifest]);
    const source = await signInitializationSource(
      {
        tenant: draft.link.tenant,
        context,
        generation: "1",
        author: subject,
        manifest: manifest.envelope.object,
        objectSignature: manifest.envelope.signature,
      },
      authority,
    );
    await required(owner.mutate("zerotrust.setup.backup.begin", source));
    await required(peer.mutate("zerotrust.setup.backup.begin", source));
    assert.equal(
      (await readInitializationSource(peer, signal))?.source?.signature,
      source.signature,
    );
    await assert.rejects(() => initializeTenant(owner, signal, duckDriver));

    const plaintext = sourceSql([
      row("users", {
        id: "87",
        username: draft.username,
        first_name: "Franz",
        last_name: "Altbestand",
        contract_type: "internal",
        cost_per_hour: 73.25,
        vacation_days_per_year: 28,
        ui_locale: "de",
      }),
      row("products", {
        id: "91",
        custom_id: "1",
        name: "Fassadenfarbe",
        description:
          "Matte Silikonharzfarbe für das WDVS-System. https://shop.beispiel.de/putz",
        base_unit: "l",
        other_units: "{}",
      }),
    ]);
    const zipped = await new Response(
      new Blob([plaintext]).stream().pipeThrough(new CompressionStream("gzip")),
    ).blob();
    const opened = await openPostgresBackup(zipped, signal, await duckDriver());
    try {
      await preparePersonnel(
        owner,
        opened.database,
        subject,
        signal,
        duckDriver,
      );
      await prepareProductCatalog(owner, opened.database, subject, signal);
    } finally {
      await opened.database.close();
    }
    const business = createBusinessClient(peer, { productDriver: duckDriver });
    try {
      const imported = await required(
        business.query("users.get", { id: "2n" }),
      );
      assert.equal(imported.firstName, "Franz");
      assert.equal(imported.costPerHour, 73.25);
      const products = await required(
        business.query("products.list", { search: "Silikonharzfarbe" }),
      );
      assert.equal(products.length, 1);
      assert.equal(products[0]!.name, "Fassadenfarbe");
      for (const search of ["WDVS-Sys", "shop.beispiel.de/putz"]) {
        const hits = await required(business.query("products.list", { search }));
        assert.deepEqual(hits.map(({ name }) => name), ["Fassadenfarbe"]);
      }
      for (const search of ["System-WDVS", "putz"]) {
        const hits = await required(business.query("products.list", { search }));
        assert.deepEqual(hits, []);
      }
    } finally {
      business.dispose();
    }

    archive.close();
    archive = await protectedCollection(owner, area, signal);
    await archive.read();
    const receipt = await archive.packet(`${context}:receipt`, {
      format: "sortsys-backup-receipt-v1",
      rows: "2",
      sourceSignature: source.signature,
    });
    await archive.write([receipt]);
    const completion = await signInitializationSource(
      {
        tenant: draft.link.tenant,
        context,
        generation: "1",
        author: subject,
        manifest: receipt.envelope.object,
        objectSignature: receipt.envelope.signature,
        sourceSignature: source.signature,
      },
      authority,
    );
    await required(peer.mutate("zerotrust.setup.backup.complete", completion));
    await required(owner.mutate("zerotrust.setup.backup.complete", completion));
    assert.equal(
      (await readInitializationSource(owner, signal))?.completion?.signature,
      completion.signature,
    );
    const forbidden = await archive.packet(`${context}:late`, {
      private: "Cannot change a completed source archive",
    });
    assert.ok((await owner.mutate("zerotrust.objects.save", forbidden))[1]);
    const ordinaryArea = {
      domain: "catalog:products:master-data",
      scope: "catalog:products",
      facet: "master-data" as const,
      prefix: "product:",
    };
    const ordinary = await protectedCollection(owner, ordinaryArea, signal);
    try {
      await ordinary.read();
      const historical = await ordinary.packet("product:3c", {
        format: "sortsys-product-v1",
        product: row("products", {
          id: "108",
          custom_id: "2",
          name: "Late source product",
          base_unit: "l",
          other_units: "{}",
        }),
        categories: [],
      });
      const origin = await attestMigrationOrigin(
        historical.envelope,
        "1",
        authority,
      );
      assert.ok(
        (
          await owner.mutate("zerotrust.objects.save", {
            ...historical,
            migrationOrigin: origin,
          })
        )[1],
      );
    } finally {
      ordinary.close();
    }
    await initializeTenant(owner, signal, duckDriver);
    assert.ok(
      (
        await required(
          peer.query("zerotrust.status", undefined, {
            strategy: "network-only",
          }),
        )
      ).initialization,
    );
    console.log(
      "Backup initialization verified: preserved owner ID, signed source context, no early browsing, local SQL/Gzip projection, encrypted native personnel/catalogue adoption, shared source receipt, immutable completed archive and denied late historical attestations.",
    );
  } finally {
    archive.close();
  }
}
