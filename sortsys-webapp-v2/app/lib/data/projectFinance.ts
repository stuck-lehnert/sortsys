import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { ProtectedWriteConflict } from "./atomicWrites";
import type { DuckDriver } from "./database";
import {
  FINANCIAL_MUTATIONS,
  financialCollection,
  financialDomain,
  financialObject,
  financialRequest,
  financialType,
  financialValue,
} from "./projectFinancialData";
import { PROJECT_MODEL, projectCollection } from "./projectData";
import {
  PROJECT_REGISTER_MODEL,
  projectCommercialCollection,
} from "./projectCommercial";
import { newProductRowId } from "./products";
import { required } from "./protectedObjects";
import { readableAreas } from "./readableAreas";
import { createBusinessRow } from "./rowCodec";
import { acquireDataRuntime } from "./runtime/session";
import { uiText } from "../i18n";

export function createProtectedProjectFinance(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate();
    },
    async query(): Promise<never> {
      throw new InvalidProtectedData();
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      live();
      cancellation?.throwIfAborted();
      if (!FINANCIAL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path.endsWith(".create");
      const updating = path.endsWith(".update");
      let fields = ["projectId", "id"];
      if (creating)
        fields = ["projectId", "type", "amount", "comment", "operationId"];
      else if (updating) fields = ["projectId", "id", "data"];
      const data = partialAddressRecord(input, fields);
      addressId(data.projectId);
      const projectId = data.projectId as string;
      const project = {
        model: PROJECT_MODEL,
        area: projectCollection(projectId),
      };
      const now = new Date().toISOString();
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const actor = addressId(session.user.id);

      if (creating) {
        const type = financialType(data.type);
        const value = financialValue({
          amount: data.amount,
          comment: data.comment,
        });
        const request = financialRequest(projectId, type);
        const id =
          data.operationId == null
            ? newProductRowId()
            : addressId(data.operationId);
        const row = createBusinessRow("project_financial_entries", {
          id,
          project_id: addressId(projectId),
          type,
          ...value,
          created_by_user_id: actor,
          created_at: now,
          commercial_case_id: null,
        });
        const object = financialObject(row);
        const register = {
          model: PROJECT_REGISTER_MODEL,
          area: projectCommercialCollection(projectId, "offer-prices"),
        };
        await runtime.transaction(
          [project, request, ...(type === "offer" ? [register] : [])],
          (transaction) => {
            cancellation?.throwIfAborted();
            if (!transaction.documents(project)[0]?.value.project)
              throw new InvalidProtectedData();
            const previous = transaction
              .documents(request)
              .find((document) => document.id === object);
            transaction.require(request, "create");
            if (previous) {
              const original = previous.value.row.values;
              if (
                original.amount !== value.amount ||
                original.comment !== value.comment ||
                original.created_by_user_id !== actor ||
                original.commercial_case_id !== null
              ) {
                throw new ProtectedWriteConflict();
              }
              return;
            }
            if (type === "offer") {
              const workflow = transaction.documents(register);
              if (workflow.length !== 1) throw new InvalidProtectedData();
              if (workflow[0]!.value.mainCaseId !== null) {
                throw new Error(
                  uiText(
                    "Zusätzliche Leistungen werden als Nachtragsangebot erfasst.",
                    "Record additional work as a variation offer.",
                  ),
                );
              }
            }
            transaction.create(request, object, {
              format: "sortsys-project-financial-v1",
              row,
              exactAmount: null,
            });
          },
          { retries: 3 },
        );
      } else {
        addressId(data.id);
        const id = addressId(data.id);
        const value = updating ? financialValue(data.data) : null;
        const areas = await readableAreas(client, signal, (domain) => {
          const part = financialDomain(domain);
          return part?.projectId === projectId
            ? financialCollection(projectId, part.type)
            : null;
        });
        live();
        const requests = areas.flatMap((area) => {
          const type = financialDomain(area.domain)!.type;
          const requests = [financialRequest(projectId, type)];
          if (type === "invoice")
            requests.push(financialRequest(projectId, type, true));
          return requests;
        });
        await runtime.transaction(
          [project, ...requests],
          (transaction) => {
            cancellation?.throwIfAborted();
            if (!transaction.documents(project)[0]?.value.project)
              throw new InvalidProtectedData();
            const matches = requests.flatMap((request) =>
              transaction
                .documents(request)
                .filter((document) => document.value.row.values.id === id)
                .map((document) => ({ request, document })),
            );
            if (matches.length !== 1) throw new InvalidProtectedData();
            const { request, document } = matches[0]!;
            if (document.value.row.values.commercial_case_id !== null) {
              throw new Error(
                uiText(
                  "Dieser Betrag wird über den zugehörigen Vorgang geändert.",
                  "Change this amount through its associated case.",
                ),
              );
            }
            if (value) {
              transaction.require(request, "update");
              transaction.edit(request, document.id, (payload) => {
                payload.row.values.amount = value.amount;
                payload.row.values.comment = value.comment;
              });
            } else transaction.delete(request, document.id);
          },
          { retries: 3 },
        );
      }
      live();
      cancellation?.throwIfAborted();
      return { success: true as const };
    },
  };
}
