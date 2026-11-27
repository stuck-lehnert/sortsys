import type { Client, QueryInput, QueryResult } from "@sortsys/v2-client";
import {
  arrayBatches,
  createWeakPairCache,
  mapConcurrent,
  splitBatchOn,
} from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { exceedsResponseBudget, required } from "./protectedObjects";

type Selection =
  QueryInput<"zerotrust.documents.messages.pages">["selections"][number];
type Page = QueryResult<"zerotrust.documents.messages.pages">[number];
type Request = {
  selection: Selection;
  live(): void;
  resolve(page: Page): void;
  reject(error: unknown): void;
};
type Queue = { pending: Request[]; running: boolean; scheduled: boolean };
const queues = createWeakPairCache<Client, object, Queue>(() => ({
  pending: [],
  running: false,
  scheduled: false,
}));

async function pages(
  client: Client,
  requests: readonly Request[],
): Promise<Page[]> {
  for (const request of requests) request.live();
  const result = await required(
    client.query(
      "zerotrust.documents.messages.pages",
      { selections: requests.map((request) => request.selection) },
      { strategy: "network-only" },
    ),
  );
  if (!Array.isArray(result) || result.length !== requests.length) {
    throw new InvalidProtectedData();
  }
  for (const request of requests) request.live();
  return result;
}

async function drain(client: Client, queue: Queue) {
  queue.running = true;
  try {
    while (queue.pending.length > 0) {
      const current = queue.pending.splice(0, 16).filter((request) => {
        try {
          request.live();
          return true;
        } catch (error) {
          request.reject(error);
          return false;
        }
      });

      const batches = [...arrayBatches(current, 4)];
      await mapConcurrent(batches, 4, async (batch) => {
        try {
          const result = await splitBatchOn(
            batch,
            (requests) => pages(client, requests),
            exceedsResponseBudget,
          );
          const copies = result.map((page) => structuredClone(page));
          for (const [index, request] of batch.entries()) {
            request.resolve(copies[index]!);
          }
        } catch (error) {
          for (const request of batch) request.reject(error);
        }
      });
    }
  } finally {
    queue.running = false;
  }
}

/** Channels share one authorization snapshot without sharing their cursors or
 * decrypted state. Each caller checks its original account before and after IO. */
export function readDocumentMessagePage(
  client: Client,
  selection: Selection,
  live: () => void,
  identity: object = client,
): Promise<Page> {
  const current = queues.getOrCreate(client, identity);
  return new Promise((resolve, reject) => {
    current.pending.push({
      selection: structuredClone(selection),
      live,
      resolve,
      reject,
    });
    if (current.running || current.scheduled) return;
    current.scheduled = true;
    // WebSocket hints arrive in separate event tasks. A small window groups
    // their channel reads as well as synchronously requested flushes.
    setTimeout(() => {
      current.scheduled = false;
      void drain(client, current);
    }, 4);
  });
}
