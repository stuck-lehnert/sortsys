import assert from "node:assert/strict";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { changeMemberAccess } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { readSelectedDocuments } from "../app/lib/data/imports";
import { required } from "../app/lib/data/protectedObjects";
import { testMemberChatCosts } from "./test-chat-costs";
import { testMemberChatTools } from "./test-chat-tools";

type Account = NonNullable<ReturnType<typeof unlockedAccount>>;
type Admission = MutateInput<"zerotrust.llm.open">;

/** Exercise the actual business facade. Calling the live socket directly would
 * miss history and catalogue gates applied before that socket is opened. */
export async function exerciseMemberAssistantWorkflows(
  owner: Client,
  member: Client,
  administrator: Account,
  participant: Account,
  id: string,
  driver: () => Promise<DuckDriver>,
  endpoint: string,
) {
  const signal = new AbortController().signal;
  const admissions: Admission[] = [];
  const wire: string[] = [];
  const observed: Client = {
    ...member,
    mutate: (async (path, input, options) => {
      wire.push(JSON.stringify(input));
      if (path === "zerotrust.llm.open")
        admissions.push(structuredClone(input) as Admission);
      return member.mutate(path, input, options);
    }) as Client["mutate"],
  };
  async function withBusiness<T>(operation: (client: Client) => Promise<T>) {
    const client = createBusinessClient(observed, {
      endpoint,
      productDriver: driver,
    });
    try {
      return await operation(client);
    } finally {
      client.dispose();
    }
  }
  const file = new File(
    ["%PDF-1.7\nMember-selected original 782169"],
    "Mitglied.pdf",
    {
      type: "application/pdf",
    },
  );
  let prepared = false;
  const prepare = async () => {
    prepared = true;
    return {
      kind: "document_import" as const,
      text: "Einlesen aus einem selbst ausgewählten Original",
      fileNames: [file.name],
      files: [{ name: file.name, mime: file.type, blob: file }],
    };
  };
  const chat = await withBusiness(async (client) => {
    assert.deepEqual(
      (await required(member.query("auth.sessionInfo", undefined))).roles,
      [],
    );
    const created = await required(
      client.mutate("llm.chats.create", {
        title: "Persönlicher Chat 782169",
      }),
    );
    const response = await required(
      client.mutate("llm.messages.send", {
        chatId: created.id,
        content: "MEMBER_LLM_BASIC",
        locale: "en",
      }),
    );
    assert.equal(
      response.messages.at(-1)?.content,
      "Persönliche Antwort ohne Katalogzugriff",
    );
    assert.deepEqual(admissions.at(-1)?.queries, []);
    assert.deepEqual(admissions.at(-1)?.mutations, []);
    assert.ok(
      (await required(client.query("llm.chats.list", undefined))).some(
        (value) => value.id === created.id,
      ),
    );
    await assert.rejects(() =>
      readSelectedDocuments(client, endpoint, [file], signal, () => {}, {
        prepare,
      }),
    );
    assert.equal(
      prepared,
      false,
      "Missing catalogue access must stop import before file preparation",
    );
    return created;
  });

  const initial = {
    catalogue: "none",
    customers: "none",
    contacts: "none",
    vendors: "none",
    prices: "none",
    assistant: true,
  } as const;
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  await changeMemberAccess(
    owner,
    `user:${id}`,
    { ...initial, catalogue: "read" },
    signal,
  );
  await acceptVaultWithKey(
    participant.dataKey,
    participant.vault,
    participant.username,
    false,
  );
  await member.clearCache();
  const scanId = await withBusiness(async (client) => {
    assert.deepEqual(
      (await required(member.query("auth.sessionInfo", undefined))).roles,
      [],
    );
    const response = await required(
      client.mutate("llm.messages.send", {
        chatId: chat.id,
        content: "LIVE_CHAT_QUERY",
        locale: "en",
      }),
    );
    assert.equal(
      response.messages.at(-1)?.content,
      "Geschützter Beschreibungstreffer gefunden",
    );
    assert.ok(admissions.at(-1)?.queries.includes("products.list"));
    assert.equal(
      admissions.at(-1)?.queries.includes("products.priceRecords.list"),
      false,
    );
    assert.deepEqual(admissions.at(-1)?.mutations, []);
    const [, denied] = await client.mutate("products.create", {
      customId: 782169,
      name: "Darf mit Leserecht nicht angelegt werden",
      baseUnit: "Stk",
    });
    assert.ok(denied);
    const id = await readSelectedDocuments(
      client,
      endpoint,
      [file],
      signal,
      () => {},
      { prepare },
    );
    assert.equal(prepared, true);
    assert.equal(admissions.at(-1)?.kind, "document_import");
    assert.deepEqual(admissions.at(-1)?.queries, ["products.list"]);
    assert.deepEqual(admissions.at(-1)?.mutations, []);
    const result = await required(
      client.mutate("deliveryNotes.scan.complete", { scanId: id }),
    );
    assert.equal(result.documentType, "deliveryNote");
    assert.ok(result.deliveryNote?.records.length);
    return id;
  });

  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  await changeMemberAccess(owner, `user:${id}`, initial, signal);
  await acceptVaultWithKey(
    participant.dataKey,
    participant.vault,
    participant.username,
    false,
  );
  await member.clearCache();
  await withBusiness(async (client) => {
    assert.ok(
      (await required(client.query("llm.chats.get", { chatId: chat.id })))
        .messages.length >= 4,
    );
    assert.ok(
      (await required(client.query("deliveryNotes.scan.list", undefined))).some(
        (value) => value.id === scanId,
      ),
    );
    prepared = false;
    await assert.rejects(() =>
      readSelectedDocuments(client, endpoint, [file], signal, () => {}, {
        prepare,
      }),
    );
    assert.equal(prepared, false);
  });
  for (const marker of [
    "Persönlicher Chat 782169",
    "MEMBER_LLM_BASIC",
    "LIVE_CHAT_QUERY",
    "Member-selected original 782169",
  ])
    assert.equal(
      wire.join("\n").includes(marker),
      false,
      "Private content must not enter persistence RPC inputs",
    );
  await testMemberChatCosts(owner, administrator, participant, id, withBusiness, chat.id, driver, signal);
  await testMemberChatTools(owner, administrator, participant, id, withBusiness, chat.id, driver, signal);
  console.log(
    "Member assistant facade verified: private chats, authenticated catalogue MCP, read-only tool scope, import without unrelated roles and preserved history after catalogue revocation.",
  );
}
