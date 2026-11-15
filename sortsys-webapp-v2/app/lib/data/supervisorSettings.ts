import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { absenceDefaultPlan } from "../crypto/absenceDefaults";
import { finishAccessChanges } from "../crypto/permissions";
import { addressId } from "./addressBook";
import { commitProtectedWrites } from "./atomicWrites";
import type { DuckDriver } from "./database";
import { ORGANIZATION_COLLECTION } from "./organizationData";
import { wirePersonnel } from "./personnelData";
import { acquireDataRuntime } from "./runtime/session";
import {
  defaultSupervisor,
  supervisorSettingsRequest,
  supervisorUserId,
  SUPERVISOR_SETTINGS_ID,
  type SupervisorSettings,
} from "./supervisorSettingsData";

export function createProtectedSupervisorSettings(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  return {
    async query(path: string, input: unknown) {
      live();
      if (
        path !== "users.supervisors.getDefault" ||
        (input !== undefined && input !== null)
      ) {
        throw new InvalidProtectedData();
      }
      const userId = await runtime.read(
        [supervisorSettingsRequest],
        defaultSupervisor,
      );
      live();
      return { userId };
    },
    async mutate(path: string, input: unknown) {
      live();
      if (path !== "users.supervisors.setDefault")
        throw new InvalidProtectedData();
      const data = record(input, ["userId"]);
      const userId = supervisorUserId(data.userId);
      // This plan opens the tenant authority as well as the encrypted personnel
      // prerequisites. Its publication binds these writes to the new policy.
      const plan = await absenceDefaultPlan(client, signal);
      live();
      runtime.revalidate();
      const prepared = await runtime.prepare(
        [...plan.selected, supervisorSettingsRequest],
        (transaction) => {
          live();
          if (userId !== null) {
            const person = wirePersonnel(transaction, userId);
            addressId(person.id);
            if (person.archivedAt || person.deactivatedAt)
              throw new InvalidProtectedData();
          }
          const previous = defaultSupervisor(transaction);
          if (previous !== userId) {
            const documents = transaction.documents(supervisorSettingsRequest);
            const value: SupervisorSettings = {
              format: "sortsys-supervisor-settings-v1",
              userId,
            };
            if (documents.length === 0) {
              transaction.create(
                supervisorSettingsRequest,
                SUPERVISOR_SETTINGS_ID,
                value,
              );
            } else {
              transaction.edit(
                supervisorSettingsRequest,
                SUPERVISOR_SETTINGS_ID,
                (payload) => {
                  payload.userId = userId;
                },
              );
            }
          }
          return plan.next(transaction);
        },
      );
      try {
        if (prepared.groups.length || plan.changed(prepared.value)) {
          await commitProtectedWrites(
            client,
            prepared.groups,
            signal,
            prepared.guards,
            {
              ...(plan.changed(prepared.value)
                ? { policy: plan.publication(prepared.value) }
                : {}),
            },
          );
          live();
        }
      } finally {
        prepared.close();
      }
      await finishAccessChanges(client, signal);
      live();
      return { success: true as const };
    },
    async refresh() {
      live();
      runtime.invalidate(new Set([ORGANIZATION_COLLECTION.domain]));
    },
    close: lease.close,
  };
}
