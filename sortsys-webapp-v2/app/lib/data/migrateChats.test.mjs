import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import { chatProposal, proposalPrefix } from "./chatData";
import { openChatStore } from "./chatStore";
import { commitProtectedWrites } from "./atomicWrites";
import {
  legacyProposalPayload,
  readChatProposal,
  prepareLegacyReview,
} from "./legacyChatProposals";
import { chatCollection, chatSources, copyChats } from "./migrateChats";
import { PRODUCT_COLLECTION } from "./products";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import {
  legacyChatSources,
  CHAT_PRIVATE_MESSAGE,
  CHAT_PRIVATE_TITLE,
} from "./testing/chatSources.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";

afterEach(() => lockCryptoSession());

const area = chatCollection("user:1");
const otherArea = chatCollection("user:2");
const object = (id) => proposalPrefix("a") + BigInt(id).toString(32);
async function fixture(actions) {
  const tenant = await protectedTenant(
    [area, otherArea, PRODUCT_COLLECTION],
    actions,
    { backup: true },
  );
  tenant.state.roles = [":llm", "view:products", "manage:products"];
  const controller = new AbortController();
  return { ...tenant, controller, signal: controller.signal };
}

test("legacy conversion preserves every status, unattached proposals, source JSON and microseconds", () => {
  const input = legacyChatSources();
  const before = JSON.stringify(input);
  const sources = chatSources(input);
  expect([...sources.keys()]).toEqual(["user:1", "user:2"]);
  const entries = sources.get("user:1");
  expect(entries).toHaveLength(8);
  const legacy = entries.find((entry) => entry.id === object("30")).value;
  expect(legacy.source).toEqual(input.proposals[0]);
  const proposal = readChatProposal(legacy, object("30"));
  expect(proposal.assistantMessageId).toBeNull();
  expect(proposal.executionResults).toBeNull();
  expect(proposal.status).toBe("accepted");
  expect(proposal.createdAt).toBe("2026-11-01T10:20:30.123456Z");
  expect(proposal.reviewedAt).toBe("2026-11-01T10:21:30.654321Z");
  expect(() => chatProposal(proposal, object("30"))).toThrow();
  expect(JSON.stringify(input)).toBe(before);
});

test("source conversion rejects cross-chat message references, duplicates and invalid schemas before publication", () => {
  const badSources = [];
  let input = legacyChatSources();
  input.proposals[0].values.assistant_message_id = "22";
  badSources.push(input);
  input = legacyChatSources();
  input.proposals[0].values.assistant_message_id = "20";
  badSources.push(input);
  input = legacyChatSources();
  input.chats.push(input.chats[0]);
  badSources.push(input);
  input = legacyChatSources();
  input.proposals.push(input.proposals[0]);
  badSources.push(input);
  input = legacyChatSources();
  input.messages[0].values.chat_id = "99";
  badSources.push(input);
  input = legacyChatSources();
  input.proposals[0].values.unknown = true;
  badSources.push(input);
  for (const source of badSources) expect(() => chatSources(source)).toThrow();
});

test("confirmed encrypted migration resumes exactly and rejects changed source data", async () => {
  const tenant = await fixture();
  try {
    const source = legacyChatSources();
    tenant.state.loseReply = true;
    await copyChats(tenant.client, source, tenant.signal);
    const saved = structuredClone([...tenant.objects]);
    const beforeReplay = tenant.calls.length;
    await copyChats(tenant.client, source, tenant.signal);
    const replay = tenant.calls.slice(beforeReplay);

    expect([...tenant.objects]).toEqual(saved);
    const accessReads = replay.filter(
      ({ path }) => path === "zerotrust.access.snapshot",
    );
    expect(accessReads).toHaveLength(1);
    expect(replay.some(({ path }) => path === "zerotrust.objects.batch")).toBe(
      false,
    );
    for (const [subject, entries] of chatSources(source)) {
      for (const { id, value } of entries) {
        expect(await tenant.plain(chatCollection(subject), id)).toEqual(value);
      }
    }

    const store = await openChatStore(tenant.client, tenant.signal);
    try {
      expect(await store.list()).toHaveLength(1);
      const state = await store.load("a");
      expect(state.messages[0].content).toBe(CHAT_PRIVATE_MESSAGE);
      expect(state.proposals.map((value) => value.status)).toEqual([
        "accepted",
        "accepted",
        "declined",
        "revision_requested",
        "pending",
      ]);
      expect(store.detail(state).proposals[0].executionResults).toBeNull();
    } finally {
      store.close();
    }
    source.proposals[0].values.summary = "Veränderte Quelle";
    await expect(
      copyChats(tenant.client, source, tenant.signal),
    ).rejects.toThrow();
    expect([...tenant.objects]).toEqual(saved);
    const wire = JSON.stringify(tenant.calls);
    for (const secret of [CHAT_PRIVATE_TITLE, "472915", "729361", "583192"])
      expect(wire.includes(secret)).toBe(false);
    expect(tenant.calls.some((call) => call.path.startsWith("llm."))).toBe(
      false,
    );
  } finally {
    tenant.controller.abort();
  }
});

test("a migrated pending proposal receives a current decision while preserving its original row", async () => {
  const tenant = await fixture();
  try {
    const source = legacyChatSources();
    await copyChats(tenant.client, source, tenant.signal);
    const store = await openChatStore(tenant.client, tenant.signal);
    try {
      const state = await store.load("a");
      const proposal = state.proposals.find((value) => value.id === "12");
      const changed = {
        ...proposal,
        status: "accepted",
        reviewComment: null,
        reviewedAt: "2026-11-02T10:00:00.123457Z",
        executionResults: [{ path: "products.create", output: { id: "3" } }],
      };
      const plan = await store.prepare(state, [changed]);
      await commitProtectedWrites(tenant.client, [plan], tenant.signal);
      const saved = await tenant.plain(area, object("34"));
      expect(saved.source).toEqual(source.proposals[4]);
      expect(saved.review.status).toBe("accepted");
      expect(
        (await store.load("a")).proposals.find((value) => value.id === "12")
          .executionResults,
      ).toEqual(changed.executionResults);
      expect(() =>
        prepareLegacyReview(
          { ...changed, title: "Erfunden" },
          saved,
          object("34"),
        ),
      ).toThrow();
    } finally {
      store.close();
    }
  } finally {
    tenant.controller.abort();
  }
});

test("historical acceptance is idempotent and never calls the model or repeats an operation", async () => {
  const tenant = await fixture();
  await copyChats(tenant.client, legacyChatSources(), tenant.signal);
  const business = createBusinessClient(tenant.client, {
    productDriver: duckDriver,
  });
  try {
    const before = structuredClone([...tenant.objects]);
    const [detail, error] = await business.query("llm.chats.get", {
      chatId: "a",
    });
    expect(error).toBeNull();
    expect(detail.proposals[0].status).toBe("accepted");
    expect(detail.proposals[0].executionResults).toBeNull();
    expect(
      (
        await business.mutate("llm.proposals.review", {
          proposalId: "u",
          decision: "accept",
          continueConversation: true,
        })
      )[1],
    ).toBeNull();
    expect([...tenant.objects]).toEqual(before);
    expect(
      tenant.calls.some(
        (call) =>
          call.path.startsWith("llm.") || call.path.startsWith("products."),
      ),
    ).toBe(false);
  } finally {
    business.dispose();
    tenant.controller.abort();
  }
});

test("legacy reviews cannot fabricate missing results, alter the source or cross object bindings", () => {
  const source = legacyChatSources().proposals[4];
  const legacy = legacyProposalPayload(
    { format: "sortsys-chat-legacy-proposal-v1", source, review: null },
    object("34"),
  );
  const proposal = readChatProposal(legacy, object("34"));
  const accepted = {
    ...proposal,
    status: "accepted",
    reviewedAt: "2026-11-02T00:00:00.000000Z",
  };
  expect(() => prepareLegacyReview(accepted, legacy, object("34"))).toThrow();
  expect(() =>
    legacyProposalPayload({ ...legacy, extra: true }, object("34")),
  ).toThrow();
  expect(() => legacyProposalPayload(legacy, object("33"))).toThrow();
  expect(() =>
    prepareLegacyReview(
      {
        ...accepted,
        executionResults: [{ path: "products.update", output: {} }],
      },
      legacy,
      object("34"),
    ),
  ).toThrow();
});

test("accepting a migrated pending product change commits its current result and original source together", async () => {
  const tenant = await fixture();
  await copyChats(tenant.client, legacyChatSources(), tenant.signal);
  const business = createBusinessClient(tenant.client, {
    productDriver: duckDriver,
  });
  try {
    tenant.state.loseReply = true;
    const [, error] = await business.mutate("llm.proposals.review", {
      proposalId: "12",
      decision: "accept",
      continueConversation: false,
    });
    expect(error).toBeNull();
    const [detail] = await business.query("llm.chats.get", { chatId: "a" });
    const accepted = detail.proposals.find((proposal) => proposal.id === "12");
    expect(accepted.status).toBe("accepted");
    const productId = accepted.executionResults[0].output.id;
    const [product] = await business.query("products.get", { id: productId });
    expect(product.name).toBe("Historisches Putzprofil 583192");
    const saved = await tenant.plain(area, object("34"));
    expect(saved.source).toEqual(legacyChatSources().proposals[4]);
    const firstPublication = tenant.objects.get(object("34")).signature;
    await business.mutate("llm.proposals.review", {
      proposalId: "12",
      decision: "accept",
      continueConversation: true,
    });
    expect(tenant.objects.get(object("34")).signature).toBe(firstPublication);
    expect(
      [...tenant.objects.keys()].filter((id) => id.startsWith("product:")),
    ).toHaveLength(1);
    expect(
      tenant.calls.some(
        (call) =>
          call.path.startsWith("llm.") || call.path.startsWith("products."),
      ),
    ).toBe(false);
  } finally {
    business.dispose();
    tenant.controller.abort();
  }
}, fixtureTimeout(15000));

test("a false migration acknowledgement never confirms missing source rows", async () => {
  const tenant = await fixture();
  try {
    tenant.state.discardCommit = true;
    await expect(
      copyChats(tenant.client, legacyChatSources(), tenant.signal),
    ).rejects.toThrow();
    expect(tenant.objects.size).toBe(0);
    tenant.state.discardCommit = false;
    await copyChats(tenant.client, legacyChatSources(), tenant.signal);
    expect(tenant.objects.size).toBe(10);
  } finally {
    tenant.controller.abort();
  }
});

test("private chat keys and update rights are enforced even when the account has an administrator role", async () => {
  for (const granted of [[], ["read"]]) {
    const tenant = await fixture((collection) =>
      collection.domain === area.domain
        ? granted
        : ["read", "create", "update"],
    );
    tenant.state.roles = [":admin"];
    for (const [subject, entries] of chatSources(legacyChatSources())) {
      for (const entry of entries)
        await tenant.seed(chatCollection(subject), entry.id, entry.value);
    }
    const business = createBusinessClient(tenant.client, {
      productDriver: duckDriver,
    });
    try {
      const [, readError] = await business.query("llm.chats.get", {
        chatId: "a",
      });
      if (granted.length) expect(readError).toBeNull();
      else expect(readError).toBeInstanceOf(Error);
      const previous = structuredClone([...tenant.objects]);
      const [, writeError] = await business.mutate("llm.proposals.review", {
        proposalId: "12",
        decision: "accept",
        continueConversation: false,
      });
      expect(writeError).toBeInstanceOf(Error);
      expect([...tenant.objects]).toEqual(previous);
      expect(
        [...tenant.objects.keys()].some((id) => id.startsWith("product:")),
      ).toBe(false);
    } finally {
      business.dispose();
      tenant.controller.abort();
    }
  }
}, fixtureTimeout(15000));
