import type { Client, QueryResult } from "@sortsys/v2-client";
import { verifyIdentityCertificate } from "@sortsys/zerotrust";
import type { administratorPolicyContext } from "./administration";

type DirectoryContext = Pick<
  Awaited<ReturnType<typeof administratorPolicyContext>>,
  "account" | "history"
>;

export function verifyDirectoryCertificate(
  entry: QueryResult<"zerotrust.identities.list">[number],
  { account, history }: DirectoryContext,
) {
  return verifyIdentityCertificate(
    entry.certificate,
    {
      tenant: account.tenant,
      user: entry.subject,
      generation: history.current.generation,
      keys: entry,
    },
    history.authority,
  );
}

export async function readRecipientCertificate(
  client: Client,
  expected: Parameters<typeof verifyIdentityCertificate>[1],
  authority: Parameters<typeof verifyIdentityCertificate>[2],
  live: () => void,
) {
  const [input, error] = await client.query(
    "zerotrust.identities.get",
    { subject: expected.user },
    { strategy: "network-only" },
  );
  live();
  if (error) throw error;
  if (input === null) return null;

  const verified = await verifyIdentityCertificate(input, expected, authority);
  live();
  return verified;
}
