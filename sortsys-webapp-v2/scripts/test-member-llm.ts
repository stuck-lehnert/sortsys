import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { bytes, digest, frame, sign } from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { changeMemberAccess } from "../app/lib/crypto/permissions";
import { createContentAccess } from "../app/lib/data/menuAccess";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { newAssistantId, openPrivateLlm } from "../app/lib/data/privateLlm";
import { required } from "../app/lib/data/protectedObjects";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { runLiveLlm } from "../app/lib/liveLlm";
import type { DuckDriver } from "../app/lib/data/database";

type ProviderBody = { messages: { role: string; content: unknown }[] };
export function memberModelFixture() {
  let held = false;
  let cancelled = false;
  return {
    held: () => held,
    cancelled: () => cancelled,
    reply(body: ProviderBody): Response | null {
      const text = body.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content;
      if (text === "MEMBER_LLM_BASIC") {
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Persönliche Antwort ohne Katalogzugriff",
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }
      if (text !== "MEMBER_LLM_WAIT") return null;
      held = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes('{"choices":['));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  };
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

export async function testMemberLlm(
  owner: Client,
  business: Client,
  member: Client,
  driver: () => Promise<DuckDriver>,
  endpoint: string,
  fixture: ReturnType<typeof memberModelFixture>,
) {
  const original = unlockedAccount()!;
  const signal = new AbortController().signal;
  const created = await required(
    business.mutate("users.create", {
      operationId: publicId(newProductRowId()),
      username: "model.member",
      firstName: "Mitarbeiterin",
      lastName: "Modelltest",
      email: null,
      phone: null,
      costPerHour: 67.5,
      vacationDaysPerYear: 28,
      contractType: "internal",
      supervisorUserId: null,
    }),
  );
  const access = {
    catalogue: "none",
    customers: "none",
    contacts: "none",
    vendors: "none",
    prices: "none",
    assistant: true,
  } as const;
  const invitation = await createMemberInvitation(
    owner,
    { id: created.id, username: "model.member" },
    access,
    signal,
  );
  await signInMemberInvitation(
    member,
    invitation.link,
    "Member-model-password-2026!",
    signal,
  );
  const account = unlockedAccount()!;
  let socket: WebSocket | null = null;
  try {
    await acceptVaultWithKey(original.dataKey, original.vault, original.username, false);
    const lease = acquireDataRuntime(owner, signal, driver);
    try {
      await approveMemberInvitation(
        owner,
        invitation.link.invitation.id,
        signal,
      );
    } finally {
      lease.close();
    }
    await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
    await member.clearCache();
    assert.equal(
      (
        await required(member.query("auth.sessionInfo", undefined))
      ).roles.includes(":llm"),
      false,
    );
    assert.equal(
      (
        await required(
          member.query("llm.status", undefined, { strategy: "network-only" }),
        )
      ).hasRole,
      true,
    );
    const navigation = createContentAccess(member, () => signal);
    try {
      assert.equal((await navigation.read())?.role(":llm"), true);
    } finally {
      navigation.close();
    }
    const noTools = {
      queries: [],
      mutations: [],
      async execute() {
        throw new Error("No catalogue tools were delegated");
      },
    };
    const reply = await runLiveLlm(
      member,
      endpoint,
      {
        kind: "chat",
        chatId: newAssistantId(),
        turns: [{ role: "user", content: "MEMBER_LLM_BASIC" }],
      },
      noTools,
      signal,
    );
    assert.equal(reply.content, "Persönliche Antwort ohne Katalogzugriff");
    const personalId = newAssistantId();
    const personal = await openPrivateLlm(member, signal);
    try {
      await personal.save("chat", personalId, { content: reply.content });
    } finally {
      personal.close();
    }
    assert.ok(
      (
        await member.query(
          "zerotrust.keys.get",
          { domain: "catalog:products:master-data", generation: "1" },
          { strategy: "network-only" },
        )
      )[1],
    );
    assert.ok(
      (
        await member.query(
          "zerotrust.keys.get",
          { domain: "catalog:products:procurement", generation: "1" },
          { strategy: "network-only" },
        )
      )[1],
    );
    assert.ok(
      (
        await member.mutate("zerotrust.llm.open", {
          kind: "document_import",
          chatId: null,
          queries: ["products.list"],
          mutations: [],
        })
      )[1],
    );

    const admission = await required(
      member.mutate("zerotrust.llm.open", {
        kind: "chat",
        chatId: newAssistantId(),
        queries: [],
        mutations: [],
      }),
    );
    const history = await trustedHistory(member);
    const proof = await sign(
      account.identity.signingKey.privateKey,
      frame("sortsys/llm-live-browser/v1", [
        account.tenant,
        admission.subject,
        history.current.generation,
        await digest(bytes(admission.ticket)),
      ]),
    );
    const target = new URL("/llm/live", endpoint);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(target);
    const messages: Record<string, unknown>[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(event.data));
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error("Member socket failed"));
    });
    socket.send(JSON.stringify({ ticket: admission.ticket, proof }));
    await waitFor(
      () => messages.some((message) => message.type === "ready"),
      "Member admission did not finish",
    );
    socket.send(
      JSON.stringify({
        type: "chat",
        turns: [{ role: "user", content: "MEMBER_LLM_WAIT" }],
        locale: "de",
      }),
    );
    await waitFor(fixture.held, "Member model did not start");

    // Keep the raw connection open while an administrator on the other API
    // revokes access. This proves server enforcement without a cooperative UI.
    await acceptVaultWithKey(original.dataKey, original.vault, original.username, false);
    await changeMemberAccess(
      owner,
      `user:${created.id}`,
      { ...access, assistant: false },
      signal,
      { actions: {}, assistant: false },
    );
    await waitFor(
      () => messages.some((message) => message.type === "error"),
      "Revocation did not stop the active request",
    );
    await waitFor(
      fixture.cancelled,
      "The model response remained open after revocation",
    );
    assert.equal(
      messages.some((message) => message.type === "complete"),
      false,
    );
    socket.close();
    socket = null;
    await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
    await member.clearCache();
    assert.equal(
      (
        await required(
          member.query("llm.status", undefined, { strategy: "network-only" }),
        )
      ).hasRole,
      false,
    );
    assert.ok(
      (
        await member.mutate("zerotrust.llm.open", {
          kind: "chat",
          chatId: newAssistantId(),
          queries: [],
          mutations: [],
        })
      )[1],
    );

    await acceptVaultWithKey(original.dataKey, original.vault, original.username, false);
    await changeMemberAccess(owner, `user:${created.id}`, access, signal, {
      actions: {},
      assistant: true,
    });
    await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
    await member.clearCache();
    assert.equal(
      (
        await required(
          member.query("llm.status", undefined, { strategy: "network-only" }),
        )
      ).hasRole,
      true,
    );
    const reopened = await openPrivateLlm(member, signal);
    try {
      assert.deepEqual(
        (await reopened.list("chat")).find((row) => row.id === personalId)
          ?.value,
        { content: reply.content },
      );
    } finally {
      reopened.close();
    }
    console.log(
      "Member LLM verified: signed invitation rights without legacy roles, private history, denied catalogue/price keys, denied import, cross-instance revocation of an uncooperative connection, provider cancellation and reactivation with preserved history.",
    );
  } finally {
    socket?.close();
    member.setToken(null);
    await acceptVaultWithKey(original.dataKey, original.vault, original.username, false);
  }
}
