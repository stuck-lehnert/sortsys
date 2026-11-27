import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { required } from "../protectedResult";

const MAX_MEMBERS = 10_000;

export async function* readMemberPages(client: Client, live: () => void) {
  const cursors = new Set<string>();
  let after: string | null = null;
  let count = 0;

  do {
    live();
    const page: QueryResult<"zerotrust.members.list"> = await required(
      client.query(
        "zerotrust.members.list",
        { after },
        { strategy: "network-only" },
      ),
    );
    live();

    count += page.rows.length;
    const next = page.after;
    if (
      count > MAX_MEMBERS ||
      (next !== null && (!page.rows.length || cursors.has(next)))
    ) {
      throw new InvalidProtectedData();
    }

    if (next !== null) cursors.add(next);
    yield page.rows;
    after = next;
  } while (after !== null);
}
