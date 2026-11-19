import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  ADDRESS_WRITE_ACTIONS,
  CONTACT_COLLECTION,
  addressBookActor,
  addressBookCommand,
  addressWriteRequests,
  isAddressWrite,
} from "./addressBook";
import type { AssistantAccess } from "./assistantStore";
import type { ChatOperation } from "./chatData";
import type { DuckDriver } from "./database";
import {
  attachPlanningTitles,
  type PlanningTitleChange,
} from "./planningTitlePublication";
import {
  PRODUCT_COLLECTION,
  PRODUCT_WRITE_ACTIONS,
  isProductWrite,
  productCommand,
} from "./products";
import {
  isProjectEdit,
  PROJECT_EDITS,
  projectCollection,
  projectDomainId,
} from "./projectData";
import { projectEditCommand } from "./projectWrites";
import type { Collection } from "./protectedObjects";
import type { DataCommand, PreparedData } from "./runtime/runtime";
import { acquireDataRuntime } from "./runtime/session";

type Output = { id: string } | { success: true };
type Applied = { path: string; output: Output };
type CommandOutput = Output & { planningTitle?: PlanningTitleChange };
type PreparedChatOperations = PreparedData<Applied[]> & {
  sealPlanningTitles(): Promise<void>;
};

export function chatMutationPaths(access: AssistantAccess): string[] {
  function mayWrite(target: Collection, action: "create" | "update" | "delete") {
    return access.allows(target.scope, target.facet, action);
  }

  const products = access.canRead(PRODUCT_COLLECTION)
    ? Object.entries(PRODUCT_WRITE_ACTIONS)
        .filter(([, action]) => mayWrite(PRODUCT_COLLECTION, action))
        .map(([path]) => path)
    : [];
  const addresses = Object.keys(ADDRESS_WRITE_ACTIONS).filter((path) => {
    if (!isAddressWrite(path)) return false;
    const requests = addressWriteRequests(path);
    return (
      mayWrite(requests[0].area, ADDRESS_WRITE_ACTIONS[path]) &&
      requests.every(({ area }) => access.canRead(area))
    );
  });
  const canEditProject = access.domains.some(({ id }) => {
    const projectId = projectDomainId(id);
    if (projectId === null) return false;
    const target = projectCollection(projectId);
    return access.canRead(target) && mayWrite(target, "update");
  });
  const mayAssignContact = access.canRead(CONTACT_COLLECTION);
  const projects = canEditProject
    ? PROJECT_EDITS.filter((path) =>
        mayAssignContact || (path !== "projects.contacts.add" && path !== "projects.contacts.set"),
      )
    : [];
  return [...products, ...addresses, ...projects];
}

/** Prepare the same commands as the forms, for publication with the receipt. */
export async function prepareChatOperations(
  client: Client,
  operations: readonly ChatOperation[],
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<PreparedChatOperations> {
  if (!operations.length || operations.length > 10) throw new InvalidProtectedData();
  const lease = acquireDataRuntime(client, signal, driver);
  let prepared: PreparedData<{ path: string; output: CommandOutput }[]> | undefined;

  try {
    let user: Promise<string> | undefined;
    const actor = () => (user ??= addressBookActor(client));
    const commands: { path: string; command: DataCommand<CommandOutput> }[] = [];
    for (const { path, input } of operations) {
      lease.live();
      if (isProductWrite(path)) {
        commands.push({ path, command: productCommand(path, input) });
      } else if (isAddressWrite(path)) {
        commands.push({ path, command: await addressBookCommand(path, input, actor) });
      } else if (isProjectEdit(path)) {
        commands.push({
          path,
          command: await projectEditCommand(client, lease.runtime, path, input),
        });
      } else {
        throw new InvalidProtectedData();
      }
    }

    prepared = await lease.runtime.prepare(
      commands.flatMap(({ command }) => command.requests),
      (tx) =>
        commands.map(({ path, command }) => {
          lease.live();
          return { path, output: command.apply(tx) };
        }),
    );
    lease.live();
    const result = prepared;
    const planningTitles: PlanningTitleChange[] = [];
    const value = result.value.map(
      ({ path, output: { planningTitle, ...output } }) => {
        if (planningTitle) planningTitles.push(planningTitle);
        return { path, output };
      },
    );
    return {
      ...result,
      value,
      sealPlanningTitles() {
        lease.live();
        return attachPlanningTitles(client, result.groups, planningTitles, signal);
      },
      close() {
        result.close();
        lease.close();
      },
    };
  } catch (error) {
    prepared?.close();
    lease.close();
    throw error;
  }
}
