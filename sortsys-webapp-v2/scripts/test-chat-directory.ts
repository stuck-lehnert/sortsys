import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { CONTACT_COLLECTION, CUSTOMER_COLLECTION } from "../app/lib/data/addressBook";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { readOwnAssignments } from "../app/lib/data/planningRecipients";
import { projectCollection } from "../app/lib/data/projectData";
import { required } from "../app/lib/data/protectedObjects";
import { VENDOR_COLLECTION } from "../app/lib/data/vendorData";
import {
  chatToolAnswer,
  chatToolCalls,
  chatToolProperties,
  type ChatToolRequest,
} from "./chat-tool-fixture";
import { revokedCustomerName } from "./test-chat-address-writes";

const customerName = "Auftraggeber Farnbrunnen";
const contactEmail = "bauleitung.farnbrunnen@example.test";
const originalTitle = "Farnbrunnen Sanierung";
const privateTitle = "Farnbrunnen gesperrte Baustelle";
const finishedTitle = "Farnbrunnen Sanierung abgeschlossen";
const vendorName = "Baustoffe West";
const confirmed = "Adressdaten und Projektverknüpfungen geprüft";

export function chatDirectoryReply(body: ChatToolRequest): Response | null {
  const prompt = body.messages.filter(({ role }) => role === "user").at(-1)?.content;
  if (typeof prompt === "string" && prompt.startsWith("PROJECT_WRITE ")) {
    return projectWriteReply(body, prompt);
  }
  if (typeof prompt !== "string" || !prompt.startsWith("DIRECTORY_FIXTURE ")) return null;
  const [, mode, customerId, contactId, projectId] = prompt.split(" ");
  const both = mode === "both";
  const results = body.messages.filter(({ role }) => role === "tool");
  if (!results.length) {
    const resources = chatToolProperties(body, "sortsys_search")?.resource?.enum;
    const paths = chatToolProperties(body, "sortsys_query")?.path?.enum;
    assert.ok(resources);
    assert.ok(paths);
    assert.equal(chatToolProperties(body, "sortsys_propose_change"), undefined);
    assert.ok(resources.includes("customers"));
    assert.ok(resources.includes("projects"));
    assert.equal(resources.includes("contacts"), both);
    assert.equal(resources.includes("vendors"), both);
    for (const path of ["customers.contacts.list", "contacts.projects.list", "projects.contacts.list"]) {
      assert.equal(paths.includes(path), both);
    }

    return chatToolCalls([
      { id: "customer", name: "sortsys_search", args: { resource: "customers", query: "Eibenweg", limit: 1 } },
      { id: "project", name: "sortsys_search", args: { resource: "projects", query: "Farnbrunnen" } },
      { id: "relation", name: "sortsys_query", args: { path: "customers.contacts.list", input: { customerId } } },
      { id: "contact", name: "sortsys_search", args: { resource: "contacts", query: contactEmail } },
      ...(both ? [
        { id: "reverse", name: "sortsys_query", args: { path: "contacts.projects.list", input: { contactId } } },
        {
          id: "project-contact",
          name: "sortsys_query",
          args: { path: "projects.contacts.list", input: { projectId } },
        },
        { id: "vendor", name: "sortsys_search", args: { resource: "vendors", query: "Quellmörtel" } },
      ] : []),
    ]);
  }

  const output = new Map(results.map(({ tool_call_id, content }) => [tool_call_id, JSON.parse(String(content))]));
  assert.equal(output.get("customer")?.structuredContent?.records[0]?.name, customerName);
  const projects = output.get("project")?.structuredContent?.records;
  assert.deepEqual(projects?.map(({ id }: { id: string }) => id), [projectId]);
  assert.equal(JSON.stringify(results).includes(privateTitle), false);
  if (both) {
    const contacts = output.get("contact")?.structuredContent?.records;
    assert.deepEqual(contacts.map((row: { id: string }) => row.id), [contactId]);
    assert.equal(contacts[0].emailAddresses[0].email, contactEmail);
    assert.equal(output.get("relation")?.structuredContent?.data[0]?.id, contactId);
    const linkedProjects = output.get("reverse")?.structuredContent?.data;
    assert.deepEqual(linkedProjects?.map(({ id }: { id: string }) => id), [projectId]);
    assert.equal(output.get("project-contact")?.structuredContent?.data[0]?.label, "Bauleitung");
    assert.equal(output.get("vendor")?.structuredContent?.records[0]?.name, vendorName);
  } else {
    assert.equal(output.get("relation")?.isError, true);
    assert.equal(output.get("contact")?.isError, true);
    assert.equal(JSON.stringify(results).includes(contactEmail), false);
  }
  return chatToolAnswer(confirmed);
}

function projectWriteReply(body: ChatToolRequest, prompt: string): Response {
  const [, mode, projectId, hiddenProjectId, contactId] = prompt.split(" ");
  const result = body.messages.find(({ role }) => role === "tool");
  if (result) {
    const output = JSON.parse(String(result.content));
    if (mode === "hidden") {
      assert.equal(output.isError, true);
      return chatToolAnswer("Projektänderung abgewiesen");
    }
    assert.equal(output.structuredContent?.savedForReview, true);
    return chatToolAnswer("<proposal-only>");
  }

  assert.ok(chatToolProperties(body, "sortsys_propose_change"));
  const operations = [];
  if (mode === "resume") {
    operations.push({
      path: "projects.resume",
      input: { id: projectId },
      description: "Projekt wieder öffnen",
    });
  } else {
    for (const title of ["Farnbrunnen Zwischenstand", finishedTitle]) {
      operations.push({
        path: "projects.update",
        input: { id: projectId, data: { title } },
        description: "Projektbezeichnung ändern",
      });
    }
    operations.push({
      path: "projects.contacts.set",
      input: { projectId, contacts: [{ contactId, label: "Abnahme" }] },
      description: "Ansprechpartner für die Abnahme hinterlegen",
    });
    operations.push({
      path: "projects.finish",
      input: { id: mode === "hidden" ? hiddenProjectId : projectId },
      description: "Projekt abschließen",
    });
  }
  return chatToolCalls([{
    id: "project-change",
    name: "sortsys_propose_change",
    args: { title: "Projektstand ändern", summary: "Vorgeschlagene Projektänderungen", operations },
  }]);
}

type Account = NonNullable<ReturnType<typeof unlockedAccount>>;

export async function testMemberChatDirectory(
  owner: Client,
  administrator: Account,
  participant: Account,
  memberId: string,
  withBusiness: <T>(operation: (client: Client) => Promise<T>) => Promise<T>,
  chatId: string,
  driver: () => Promise<DuckDriver>,
  signal: AbortSignal,
) {
  async function asAdministrator<T>(work: () => Promise<T>) {
    await acceptVaultWithKey(administrator.dataKey, administrator.vault, administrator.username, false);
    try {
      return await work();
    } finally {
      await acceptVaultWithKey(participant.dataKey, participant.vault, participant.username, false);
    }
  }
  const fixture = await asAdministrator(async () => {
    const business = createBusinessClient(owner, { productDriver: driver });
    try {
      const { id: customerId } = await required(business.mutate("customers.create", {
        name: customerName,
        address: { streetAddress: "Eibenweg 41", city: "Nürnberg" },
      }));
      const { id: contactId } = await required(business.mutate("contacts.create", {
        firstName: "Mara",
        lastName: "Lenk",
        emailAddresses: [{ email: contactEmail }],
      }));
      await required(business.mutate("customers.contacts.add", { customerId, contactId }));

      async function createProject(title: string) {
        const { id: projectId } = await required(business.mutate("projects.create", { title, customerId }));
        await required(business.mutate("projects.contacts.add", { projectId, contactId, label: "Bauleitung" }));
        return projectId;
      }

      const projectId = await createProject(originalTitle);
      const hiddenProjectId = await createProject(privateTitle);
      const assignment = await required(business.mutate("projects.deployments.create", {
        projectId,
        userId: memberId,
        from: new Date("2026-11-23T07:00:00Z"),
        to: new Date("2026-11-23T15:00:00Z"),
        note: null,
      }));
      await required(business.mutate("products.vendors.create", {
        name: vendorName,
        description: "Quellmörtel und Reparaturprodukte",
      }));
      await changeAreaActionAccesses(owner, `user:${memberId}`, [
        { area: CUSTOMER_COLLECTION, patch: { read: true } },
        { area: projectCollection(projectId), patch: { read: true } },
      ], signal);
      return { customerId, contactId, projectId, hiddenProjectId, assignmentId: assignment.id };
    } finally {
      business.dispose();
    }
  });

  async function check(mode: "customer" | "both") {
    await withBusiness(async (client) => {
      if (mode === "customer") {
        const [, error] = await client.query("contacts.projects.list", { contactId: fixture.contactId });
        assert.ok(error, "Knowing a contact ID must not open its reverse project relations");
      }
      const { customerId, contactId, projectId } = fixture;
      const result = await required(client.mutate("llm.messages.send", {
        chatId,
        content: `DIRECTORY_FIXTURE ${mode} ${customerId} ${contactId} ${projectId}`,
      }));
      assert.equal(result.messages.at(-1)?.content, confirmed);
    });
  }

  await check("customer");
  for (const read of [true, false]) {
    await asAdministrator(() => changeAreaActionAccesses(owner, `user:${memberId}`, [
      { area: CONTACT_COLLECTION, patch: { read } },
      { area: VENDOR_COLLECTION, patch: { read } },
    ], signal));
    await check(read ? "both" : "customer");
  }

  const setCreate = (create: boolean) => asAdministrator(() => changeAreaActionAccesses(
    owner, `user:${memberId}`, [{ area: CUSTOMER_COLLECTION, patch: { create } }], signal,
  ));
  await setCreate(true);
  const proposalId = await withBusiness(async (client) => {
    const result = await required(client.mutate("llm.messages.send", {
      chatId,
      content: "ADDRESS_WRITE member",
    }));
    assert.equal(result.proposals.at(-1)?.status, "pending");
    return result.proposals.at(-1)!.id;
  });
  await setCreate(false);
  await withBusiness(async (client) => {
    const [, error] = await client.mutate("llm.proposals.review", { proposalId, decision: "accept" });
    assert.ok(error, "The approval must use current write permissions");
    const history = await required(client.query("llm.chats.get", { chatId }));
    assert.equal(history.proposals.find(({ id }) => id === proposalId)?.status, "pending");
    assert.deepEqual(await required(client.query("customers.list", { search: revokedCustomerName })), []);
  });

  const { projectId, hiddenProjectId, contactId } = fixture;
  const setProjectRights = (update: boolean) => asAdministrator(() =>
    changeAreaActionAccesses(owner, `user:${memberId}`, [
      { area: projectCollection(projectId), patch: { update } },
      { area: CONTACT_COLLECTION, patch: { read: update } },
    ], signal),
  );
  const requestProjectChange = (client: Client, mode: string) =>
    required(client.mutate("llm.messages.send", {
      chatId,
      content: `PROJECT_WRITE ${mode} ${projectId} ${hiddenProjectId} ${contactId}`,
    }));
  await setProjectRights(true);
  const staleProjectProposal = await withBusiness(async (client) => {
    const before = await required(client.query("llm.chats.get", { chatId }));
    const hidden = await requestProjectChange(client, "hidden");
    assert.equal(hidden.proposals.length, before.proposals.length);
    assert.equal(hidden.messages.at(-1)?.content, "Projektänderung abgewiesen");

    const proposed = await requestProjectChange(client, "finish");
    const proposal = proposed.proposals.find(({ status, title }) =>
      status === "pending" && title === "Projektstand ändern",
    )!;
    const getProject = () => required(client.query("projects.get", { id: projectId }));
    assert.equal((await getProject()).title, originalTitle);
    assert.equal((await getProject()).finishedAt, null);
    const previousAssignment = (await readOwnAssignments(client, signal, projectId))
      .find(({ id }) => id.endsWith(`:${fixture.assignmentId}`));
    assert.ok(previousAssignment);
    assert.equal(previousAssignment.value.projectTitle, originalTitle);
    const confirm = { proposalId: proposal.id, decision: "accept" } as const;
    await required(client.mutate("llm.proposals.review", confirm));
    const final = await getProject();
    assert.equal(final.title, finishedTitle);
    assert.ok(final.finishedAt);
    const assignment = (await readOwnAssignments(client, signal, projectId))
      .find(({ id }) => id === previousAssignment.id);
    assert.equal(assignment?.value.projectTitle, finishedTitle);
    assert.equal(assignment?.revision, previousAssignment.revision);
    const contacts = await required(client.query("projects.contacts.list", { projectId }));
    assert.deepEqual(contacts.map(({ id, label }) => [id, label]), [[contactId, "Abnahme"]]);
    const history = await required(client.query("llm.chats.get", { chatId }));
    const receipt = history.proposals.find(({ id }) => id === proposal.id);
    assert.equal(receipt?.status, "accepted");
    assert.deepEqual(receipt?.executionResults, [
      "projects.update", "projects.update", "projects.contacts.set", "projects.finish",
    ].map((path) => ({ path, output: { success: true } })));

    const resume = await requestProjectChange(client, "resume");
    return resume.proposals.find(({ status, title }) =>
      status === "pending" && title === "Projektstand ändern",
    )!.id;
  });
  await setProjectRights(false);
  await withBusiness(async (client) => {
    const [, error] = await client.mutate("llm.proposals.review", {
      proposalId: staleProjectProposal,
      decision: "accept",
    });
    assert.ok(error, "Approval must use current project write permissions");
    const final = await required(client.query("projects.get", { id: projectId }));
    assert.ok(final.finishedAt);
    assert.equal(final.title, finishedTitle);
  });
  console.log(
    "Chat directory verified: scoped search, project and contact approval, hidden project denial and write revocation.",
  );
}
