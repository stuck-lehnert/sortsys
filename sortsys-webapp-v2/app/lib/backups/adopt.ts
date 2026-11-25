import type { Client } from "@sortsys/v2-client";
import type { GaebXmlProcessor } from "@sortsys/gaeb";
import {
  InvalidProtectedData,
  signInitializationSource,
} from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "../data/database";
import { protectedCollection, required } from "../data/protectedObjects";
import { administratorContext } from "../crypto/administration";
import { readInitializationSource } from "../crypto/initializationSource";
import { backupArea, openBackupArchive } from "./archive";
import { reserveBackupMembers } from "./members";

export type BackupProgress = { step: string; done: number; total: number };
type Options = {
  driver?: () => Promise<DuckDriver>;
  processor?: GaebXmlProcessor;
  onProgress?(value: BackupProgress): void;
};

/** Every conversion uses the same local, verified source. Existing targets are
 * reopened and compared on retry; no live PostgreSQL source participates. */
export async function adoptBackup(
  client: Client,
  signal: AbortSignal,
  options: Options = {},
) {
  const admin = await administratorContext(client, signal);
  const state = await readInitializationSource(client, signal);
  if (!state?.source) throw new InvalidProtectedData();
  if (state.completion) return;
  const opened = await openBackupArchive(
    client,
    signal,
    options.driver ? await options.driver() : undefined,
  );
  const database = opened.database;
  const subject = `user:${admin.session.user.id}`;
  const steps: { id: string; run(): Promise<void> }[] = [
    {
      id: "members",
      run: () =>
        reserveBackupMembers(
          client,
          database,
          opened.manifest.ownerId,
          state.context,
          signal,
        ),
    },
    {
      id: "organization",
      async run() {
        const { prepareOrganization } =
          await import("../data/migrateOrganization");
        await prepareOrganization(client, database, subject, signal, {
          companyName: null,
          address: null,
        });
        const { prepareLogo } = await import("../data/migrateLogo");
        await prepareLogo(
          client,
          database,
          state.context,
          subject,
          signal,
          opened.files,
        );
        const { preparePrintTemplates } =
          await import("../data/migratePrintTemplates");
        await preparePrintTemplates(
          client,
          database,
          subject,
          signal,
          opened.files,
        );
        const { prepareCommonCosts } =
          await import("../data/migrateCommonCosts");
        await prepareCommonCosts(client, database, subject, signal);
        const { prepareClientScripts } =
          await import("../data/migrateClientScripts");
        await prepareClientScripts(client, database, subject, signal);
      },
    },
    {
      id: "personnel",
      async run() {
        const { preparePersonnel } = await import("../data/migratePersonnel");
        await preparePersonnel(
          client,
          database,
          subject,
          signal,
          options.driver,
        );
        const { prepareAbsences } = await import("../data/migrateAbsences");
        await prepareAbsences(
          client,
          database,
          subject,
          signal,
          options.driver,
        );
        const { synchronizeAbsenceDefaults } =
          await import("../crypto/absenceDefaults");
        await synchronizeAbsenceDefaults(client, signal, options.driver);
      },
    },
    {
      id: "catalogues",
      async run() {
        const { prepareProductCatalog } =
          await import("../data/migrateProducts");
        await prepareProductCatalog(client, database, subject, signal);
        const { prepareAddressBook } =
          await import("../data/migrateAddressBook");
        await prepareAddressBook(client, database, subject, signal);
        const { prepareTools } = await import("../data/migrateTools");
        await prepareTools(client, database, subject, signal);
      },
    },
    {
      id: "projects",
      async run() {
        const { prepareProjects } = await import("../data/migrateProjects");
        await prepareProjects(client, database, subject, signal);
        const { prepareProjectSchedule } =
          await import("../data/migrateProjectSchedule");
        await prepareProjectSchedule(client, database, subject, signal);
        const { prepareRemarks } = await import("../data/migrateRemarks");
        await prepareRemarks(client, database, subject, signal);
        const { prepareDeliveryNotes } =
          await import("../data/migrateDeliveryNotes");
        await prepareDeliveryNotes(client, database, subject, signal);
        const { prepareProjectFiles } =
          await import("../data/migrateProjectFiles");
        await prepareProjectFiles(
          client,
          database,
          subject,
          signal,
          opened.files,
        );
        const { prepareDailyReports } =
          await import("../data/migrateDailyReports");
        await prepareDailyReports(client, database, subject, signal);
        const { prepareRegieReports } =
          await import("../data/migrateRegieReports");
        await prepareRegieReports(client, database, subject, signal);
      },
    },
    {
      id: "commercial",
      async run() {
        const { prepareArchivedOfferNumbers } =
          await import("../data/migrateOfferNumbers");
        await prepareArchivedOfferNumbers(client, database, opened.offerNumbers, signal);

        const { prepareCommercialCases } =
          await import("../data/migrateCommercial");
        await prepareCommercialCases(client, database, subject, signal);
        const { prepareCommercialDocuments } =
          await import("../data/migrateCommercialDocuments");
        await prepareCommercialDocuments(
          client,
          database,
          signal,
          options.processor,
          opened.files,
        );
        const { prepareIssuedInvoices } =
          await import("../data/migrateBilling");
        await prepareIssuedInvoices(client, database, signal);
      },
    },
    {
      id: "personal",
      async run() {
        const { prepareChats } = await import("../data/migrateChats");
        await prepareChats(client, database, subject, signal);
        if (opened.history) {
          const { prepareImportHistory } =
            await import("../data/migrateImportHistory");
          await prepareImportHistory(
            client,
            opened.history.records,
            subject,
            state.context,
            signal,
          );
        }
        const { preparePreferences } =
          await import("../data/migratePreferences");
        await preparePreferences(client, database, subject, signal);
        const { preparePersonalHistory } =
          await import("../data/migratePersonalHistory");
        await preparePersonalHistory(client, database, subject, signal);
        const { prepareActivities } = await import("../data/migrateActivities");
        await prepareActivities(client, database, subject, signal);
      },
    },
  ];
  try {
    for (const [index, step] of steps.entries()) {
      admin.live();
      options.onProgress?.({ step: step.id, done: index, total: steps.length });
      await step.run();
    }
    admin.live();
    const collection = await protectedCollection(
      client,
      backupArea(state.context),
      signal,
    );
    try {
      await collection.read();
      const id = `${state.context}:receipt`;
      const value = {
        format: "sortsys-backup-receipt-v1",
        sourceSignature: opened.source.signature,
        rows: opened.manifest.rows,
        steps: steps.map((step) => step.id),
      };
      const previous = await collection.selected([id]);
      let signature: string;
      if (previous[0]) {
        if (JSON.stringify(previous[0].value) !== JSON.stringify(value))
          throw new InvalidProtectedData();
        signature = previous[0].envelope.signature;
      } else {
        const packet = await collection.packet(id, value);
        await collection.write([packet]);
        signature = packet.envelope.signature;
      }
      const proof = await signInitializationSource(
        {
          tenant: admin.account.tenant,
          context: state.context,
          generation: admin.history.current.generation,
          author: subject,
          manifest: id,
          objectSignature: signature,
          sourceSignature: opened.source.signature,
        },
        admin.authority,
      );
      await required(client.mutate("zerotrust.setup.backup.complete", proof));
      options.onProgress?.({
        step: "complete",
        done: steps.length,
        total: steps.length,
      });
    } finally {
      collection.close();
    }
  } finally {
    await database.close();
  }
}
