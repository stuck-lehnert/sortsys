import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  ADDRESS_WRITE_ACTIONS,
  addressBookActor,
  addressBookCommand,
  addressWriteRequests,
  isAddressWrite,
} from "./addressBook";
import type { AssistantAccess } from "./assistantStore";
import type { ChatOperation } from "./chatData";
import type { DuckDriver } from "./database";
import {
  PRODUCT_COLLECTION,
  PRODUCT_WRITE_ACTIONS,
  isProductWrite,
  productCommand,
} from "./products";
import type { Collection } from "./protectedObjects";
import type { DataCommand, PreparedData } from "./runtime/runtime";
import { acquireDataRuntime } from "./runtime/session";

type Output = { id: string } | { success: true };
type Applied = { path: string; output: Output };

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
  return [...products, ...addresses];
}

/** Prepare the same commands as the forms, for publication with the receipt. */
export async function prepareChatOperations(
  client: Client,
  operations: readonly ChatOperation[],
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<PreparedData<Applied[]>> {
  if (!operations.length || operations.length > 10) throw new InvalidProtectedData();
  const lease = acquireDataRuntime(client, signal, driver);
  let prepared: PreparedData<Applied[]> | undefined;

  try {
    let user: Promise<string> | undefined;
    const actor = () => (user ??= addressBookActor(client));
    const commands: { path: string; command: DataCommand<Output> }[] = [];
    for (const { path, input } of operations) {
      lease.live();
      if (isProductWrite(path)) {
        commands.push({ path, command: productCommand(path, input) });
      } else if (isAddressWrite(path)) {
        commands.push({ path, command: await addressBookCommand(path, input, actor) });
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
    return {
      ...result,
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
