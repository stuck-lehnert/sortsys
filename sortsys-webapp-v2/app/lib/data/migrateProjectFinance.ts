import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import {
  financialCollection,
  financialObject,
  financialPayload,
  type FinancialEntryType,
} from "./projectFinancialData";

export async function prepareProjectFinance(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const projects = await readBusinessRows(source, "projects");
  const rows = await readBusinessRows(source, "project_financial_entries");
  const projectIds = new Set(projects.map((project) => project.values.id));
  if (rows.some((row) => !projectIds.has(row.values.project_id)))
    throw new InvalidProtectedData();
  const types: FinancialEntryType[] = ["offer", "invoice"];
  const areas = projects.flatMap((project) =>
    types.map((type) => financialCollection(publicId(project.values.id), type)),
  );
  await prepareOwnerCollections(client, subject, areas, signal);
  for (const project of projects) {
    for (const type of types) {
      const entries = rows.filter(
        (row) =>
          row.values.project_id === project.values.id &&
          row.values.type === type &&
          (type === "invoice" || row.values.commercial_case_id === null),
      );
      const payloads = entries.map((row) => ({
        id: financialObject(row),
        value: {
          format: "sortsys-project-financial-v1",
          row,
          exactAmount: null,
        },
      }));
      const areas = [financialCollection(publicId(project.values.id), type)];
      if (type === "invoice")
        areas.push(
          financialCollection(publicId(project.values.id), type, true),
        );
      for (const area of areas) {
        await copyProtectedCollection(
          client,
          area,
          payloads.filter((payload) => payload.id.startsWith(area.prefix)),
          (input, object) => financialPayload(input, object, area),
          signal,
        );
      }
    }
  }
}
