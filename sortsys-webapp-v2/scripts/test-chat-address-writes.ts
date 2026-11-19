import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { CONTACT_COLLECTION, CUSTOMER_COLLECTION } from "../app/lib/data/addressBook";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";
import {
  chatToolAnswer,
  chatToolCalls,
  chatToolProperties,
  type ChatToolRequest,
} from "./chat-tool-fixture";

const customerName = "Auftraggeber aus geschütztem Vorschlag 8853";
const productName = "Aufmaßplatte für geschützten Vorschlag 8853";
const email = "planung8853@example.test";
export const revokedCustomerName = "Vertraulicher nicht bestätigter Auftraggeber 8854";

export function chatAddressWritesReply(body: ChatToolRequest): Response | null {
  const prompt = body.messages.filter(({ role }) => role === "user").at(-1)?.content;
  if (typeof prompt !== "string" || !prompt.startsWith("ADDRESS_WRITE ")) return null;
  const [, mode, customerId, contactId, extra] = prompt.split(" ");
  const result = body.messages.find(({ role }) => role === "tool");
  if (result) {
    const output = JSON.parse(String(result.content));
    if (mode === "invalid") {
      assert.equal(output.isError, true);
      return chatToolAnswer("Ungültige Felder abgewiesen");
    }
    assert.equal(output.structuredContent?.savedForReview, true);
    return chatToolAnswer("<proposal-only>");
  }

  const operations = [];
  if (mode === "mixed") {
    operations.push(
      { path: "customers.create", input: { name: customerName }, description: "Auftraggeber anlegen" },
      {
        path: "customers.contacts.add",
        input: { customerId, contactId },
        description: "Ansprechpartner zuordnen",
      },
      {
        path: "products.create",
        input: { customId: Number(extra), name: productName, baseUnit: "Stk" },
        description: "Material anlegen",
      },
    );
  } else if (mode === "member") {
    operations.push({
      path: "customers.create",
      input: { name: revokedCustomerName },
      description: "Auftraggeber anlegen",
    });
  } else if (mode === "contacts") {
    operations.push(
      {
        path: "contacts.create",
        input: { firstName: "Anton", lastName: "Muster 8853" },
        description: "Kontakt anlegen",
      },
      {
        path: "contacts.update",
        input: { id: contactId, data: { emailAddresses: [{ email }] } },
        description: "E-Mail ändern",
      },
      {
        path: "contacts.delete",
        input: { id: extra },
        description: "Veralteten Kontakt löschen",
      },
    );
  } else {
    operations.push(
      {
        path: "customers.update",
        input: { id: customerId, data: { name: "Unzulässige Teiländerung" } },
        description: "Auftraggeber umbenennen",
      },
      {
        path: "contacts.update",
        input: { id: contactId, data: { unknownField: "Nicht im Adressschema" } },
        description: "Kontakt bearbeiten",
      },
    );
  }

  assert.ok(chatToolProperties(body, "sortsys_propose_change"));
  return chatToolCalls([{
    id: "address-operation",
    name: "sortsys_propose_change",
    args: { title: "Adressbuch bearbeiten", summary: "Vorgeschlagene Stammdatenänderung", operations },
  }]);
}

export async function testChatAddressWrites(
  raw: Client,
  driver: () => Promise<DuckDriver>,
  peer: { endpoint: string; token: string },
) {
  const transport = createClient(peer.endpoint, "address-proposal-peer");
  transport.setToken(peer.token);
  const other = createBusinessClient(transport, { productDriver: driver });
  const trace: unknown[] = [];
  let interrupt: ((batch: MutateInput<"zerotrust.objects.batch">) => Promise<void>) | undefined;
  let loseReply = false;
  const observed: Client = {
    ...raw,
    mutate: (async (path, input, options) => {
      trace.push({ path, input });
      if (path !== "zerotrust.objects.batch") return raw.mutate(path, input, options);
      const batch = input as MutateInput<"zerotrust.objects.batch">;
      const addressWrite = batch.objects.some((packet) => packet.domain === CUSTOMER_COLLECTION.domain);
      if (addressWrite && interrupt) {
        const change = interrupt;
        interrupt = undefined;
        await change(batch);
      }
      const result = await raw.mutate(path, input, options);
      if (addressWrite && loseReply && !result[1]) {
        loseReply = false;
        return [null, new Error("Synthetic lost receipt reply")];
      }
      return result;
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { endpoint: peer.endpoint, productDriver: driver });
  try {
    const original = "Bestandskunde für einen Vorschlag";
    const { id: customerId } = await required(other.mutate("customers.create", { name: original }));
    const { id: contactId } = await required(other.mutate("contacts.create", { firstName: "Elli", lastName: "Bau" }));
    const { id: obsolete } = await required(other.mutate("contacts.create", { firstName: "Veralteter Eintrag" }));
    const customId = await required(other.query("products.suggestNextCustomId", undefined));
    const { id: chatId } = await required(business.mutate("llm.chats.create", {}));

    const send = (mode: string, extra: string | number) => required(business.mutate("llm.messages.send", {
      chatId,
      content: `ADDRESS_WRITE ${mode} ${customerId} ${contactId} ${extra}`,
    }));
    const invalid = await send("invalid", obsolete);
    assert.deepEqual(invalid.proposals, []);
    assert.equal((await required(other.query("customers.get", { id: customerId }))).name, original);

    const proposal = (await send("mixed", customId)).proposals.at(-1)!;
    assert.equal(proposal.status, "pending");
    const newCustomers = () => required(other.query("customers.list", { search: customerName }));
    const links = () => required(other.query("customers.contacts.list", { customerId }));
    const products = () => required(other.query("products.list", { search: productName }));
    async function refreshPeer() {
      // The detached test client has no change stream. Read each area again
      // from the second API before judging the visibility of the commit.
      await other.invalidate("customers.list");
      await other.invalidate("products.list");
    }
    assert.deepEqual(await Promise.all([newCustomers(), links(), products()]), [[], [], []]);
    assert.deepEqual(await required(business.query("customers.list", { search: customerName })), []);

    interrupt = async (batch) => {
      assert.ok(batch.heads?.some((head) => head.domain === CONTACT_COLLECTION.domain));
      assert.ok(!batch.objects.some((packet) => packet.domain === CONTACT_COLLECTION.domain));
      await required(other.mutate("contacts.update", { id: contactId, data: { lastName: "Baumann" } }));
    };
    const approve = { proposalId: proposal.id, decision: "accept" } as const;
    assert.ok((await business.mutate("llm.proposals.review", approve))[1]);
    assert.equal(interrupt, undefined);
    await refreshPeer();
    assert.deepEqual(await Promise.all([newCustomers(), links(), products()]), [[], [], []]);

    loseReply = true;
    await required(business.mutate("llm.proposals.review", approve));
    assert.equal(loseReply, false);
    await required(other.mutate("llm.proposals.review", approve));
    const saved = await required(other.query("llm.chats.get", { chatId }));
    assert.equal(saved.proposals[0]?.status, "accepted");
    assert.equal((await required(business.query("customers.list", { search: customerName }))).length, 1);
    await refreshPeer();
    const [customers, linked, createdProducts] = await Promise.all([newCustomers(), links(), products()]);
    assert.deepEqual(saved.proposals[0]?.executionResults, [
      { path: "customers.create", output: { id: customers[0]?.id } },
      { path: "customers.contacts.add", output: { success: true } },
      { path: "products.create", output: { id: createdProducts[0]?.id } },
    ]);
    assert.equal(customers.length, 1);
    const actor = await required(raw.query("auth.sessionInfo", undefined));
    assert.equal(customers[0]?.createdByUserId, actor.user.id);
    assert.equal(createdProducts.length, 1);
    assert.deepEqual(linked.map(({ id, lastName }) => [id, lastName]), [[contactId, "Baumann"]]);

    const edits = (await send("contacts", obsolete)).proposals.find((item) => item.status === "pending")!;
    assert.deepEqual((await required(other.query("contacts.get", { id: contactId }))).emailAddresses, []);
    await required(other.query("contacts.get", { id: obsolete }));
    await required(business.mutate("llm.proposals.review", { proposalId: edits.id, decision: "accept" }));
    await other.invalidate("contacts.list");
    assert.equal((await required(other.query("contacts.get", { id: contactId }))).emailAddresses[0]?.email, email);
    assert.ok((await other.query("contacts.get", { id: obsolete }))[1]);
    assert.equal((await required(other.query("contacts.list", { search: "Muster 8853" }))).length, 1);
    for (const text of [customerName, productName, email]) {
      assert.equal(JSON.stringify(trace).includes(text), false);
    }
  } finally {
    business.dispose();
    other.dispose();
    transport.setToken(null);
  }
  console.log(
    "Chat address writes verified: mixed atomic publication, a read-only contact guard, lost reply, safe repeat and no plaintext RPC.",
  );
}
