// Deterministic provider; no real model credentials or external LLM requests.
import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  bytes,
  digest,
  frame,
  sign,
  policy,
  record,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { runLiveLlm, type LiveLlmRequest } from "../app/lib/liveLlm";
import { required } from "../app/lib/data/protectedObjects";
import {
  preparePrivateLlm,
  openPrivateLlm,
  newAssistantId,
} from "../app/lib/data/privateLlm";
import { readSelectedDocuments } from "../app/lib/data/imports";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { processImport } from "../app/lib/importProcessing";
import { llmActivity } from "../app/lib/llmActivity";
import { chatModelFixture, testLiveChats } from "./test-live-chats";
import { memberModelFixture, testMemberLlm } from "./test-member-llm";
import { documentModelFixture, testChatDocuments } from "./test-chat-documents";
import type { DuckDriver } from "../app/lib/data/database";

export async function testLiveLlm(
  client: Client,
  business: Client,
  driver: () => Promise<DuckDriver>,
  options: {
    endpoint: string;
    ownerEndpoint: string;
    peerEndpoint: string;
    adminPassword: string;
  },
) {
  if (process.env.SORTSYS_DISPOSABLE_AUTH_TEST !== "1")
    throw new Error("Disposable native stack only");
  const { endpoint, ownerEndpoint } = options;
  const ip = "127.0.0.1";
  const marker = "LIVE_LLM_CONFIDENTIAL_BROWSER_ONLY_793821";
  const documentName = "test.pdf";
  const blockBytes = 512 * 1024;
  const selectedOriginal = Uint8Array.from(
    { length: 2 * blockBytes + 13 },
    (_, index) => index % 251,
  );
  let checkedProviderOriginals = 0;
  let turns = 0,
    toolReplies = 0,
    cancelled = false,
    holding: (() => void) | null = null;
  const holdStarted = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const model = "sortsys-live-llm-fixture";
  const chatFixture = chatModelFixture();
  const memberFixture = memberModelFixture();
  const documentsFixture = documentModelFixture();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer synthetic-live-fixture",
      );
      if (new URL(request.url).pathname === "/v1/models")
        return Response.json({
          data: [
            {
              id: model,
              name: "Live fixture",
              architecture: { input_modalities: ["text", "image"] },
            },
          ],
        });
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
      const body = await request.json();
      turns++;
      for (const message of body.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== "file" || part.file.filename !== documentName) {
            continue;
          }
          const prefix = "data:application/pdf;base64,";
          assert.ok(part.file.file_data.startsWith(prefix));
          assert.ok(
            Buffer.from(part.file.file_data.slice(prefix.length), "base64").equals(
              selectedOriginal,
            ),
            "The model receives the original bytes in their original order",
          );
          checkedProviderOriginals++;
        }
      }
      const documentReply = documentsFixture.reply(body);
      if (documentReply) return documentReply;
      const chat = await chatFixture.reply(body);
      if (chat) return chat;
      const member = memberFixture.reply(body);
      if (member) return member;
      if (JSON.stringify(body.messages).includes("LIVE_CANCEL")) {
        holding?.();
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
      }
      const imported = body.tools.some(
        (tool: { function: { name: string } }) =>
          tool.function.name === "sortsys_search_products",
      );
      assert.equal(JSON.stringify(body.tools).includes("zerotrust."), false);
      const reply = body.messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      if (!reply)
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "fixture-read",
                    type: "function",
                    function: {
                      name: imported
                        ? "sortsys_search_products"
                        : "sortsys_query",
                      arguments: JSON.stringify(
                        imported
                          ? { query: "Bogenberechnung", limit: 2 }
                          : {
                              path: "products.list",
                              input: { search: "Bogenberechnung" },
                            },
                      ),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      const output = JSON.parse(reply.content);
      assert.ok(!output.isError, JSON.stringify(output));
      assert.ok(
        JSON.stringify(output).includes("Bogenberechnung"),
        "MCP must obtain decrypted catalogue data from the browser",
      );
      toolReplies++;
      const matched = output.structuredContent?.records?.[0];
      const document = {
        documentType: "deliveryNote",
        supplier: "Musterlieferant",
        documentNumber: "LIVE-2026-1",
        documentDate: "2026-11-09",
        comment: null,
        lines: [
          {
            sourceText: "Browserseitig erkannte Lieferposition",
            name: matched?.name ?? "Prüfprodukt",
            brand: matched?.brand ?? null,
            description: null,
            quantity: 2.5,
            unit: matched?.baseUnit ?? "m²",
            baseUnit: matched?.baseUnit ?? "m²",
            unitConversions: [],
            productId: matched?.id ?? null,
            pricePerUnit: null,
            confidence: 0.95,
            comment: null,
          },
        ],
      };
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: imported ? JSON.stringify(document) : marker,
            },
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
      });
    },
  });
  const administrator = createClient(endpoint, "disposable-live-llm-admin");
  const admin = await required(
    administrator.mutate("admin.login", {
      tenant: null,
      password: options.adminPassword,
    }),
  );
  administrator.setToken(admin.token);
  try {
    await required(
      administrator.mutate("admin.llm.tenants.update", {
        name: unlockedAccount()!.tenant,
        enabled: true,
        monthlyTokenQuota: null,
      }),
    );
    await required(
      administrator.mutate("admin.llm.providers.update", {
        provider: "openrouter",
        baseUrl: `http://${ip}:${server.port}`,
        apiKey: "synthetic-live-fixture",
      }),
    );
    for (const useCase of ["chat", "documentImport"] as const)
      await required(
        administrator.mutate("admin.llm.useCases.update", {
          useCase,
          provider: "openrouter",
          model,
        }),
      );
    await assert.rejects(() =>
      required(
        client.mutate("zerotrust.llm.open", {
          kind: "chat",
          chatId: "1",
          queries: ["zerotrust.keys.get"],
          mutations: [],
        }),
      ),
    );
    await assert.rejects(() =>
      required(
        client.mutate("zerotrust.llm.open", {
          kind: "document_import",
          chatId: null,
          queries: ["products.list"],
          mutations: [],
          documents: true,
        }),
      ),
    );
    await preparePrivateLlm(
      client,
      `user:${(await required(client.query("auth.sessionInfo", undefined))).user.id}`,
      new AbortController().signal,
    );
    assert.equal(
      (await required(business.query("llm.status", undefined)))
        .scanProviderConfigured,
      true,
    );
    const tools = {
      queries: ["products.list"],
      mutations: [],
      async execute(name: string, input: unknown) {
        const args = input as Record<string, unknown>;
        if (name === "sortsys_query") {
          assert.equal(args.path, "products.list");
          return {
            path: args.path,
            data: await required(
              business.query("products.list", args.input as { search: string }),
            ),
          };
        }
        assert.equal(name, "sortsys_search_products");
        return {
          records: (
            await required(
              business.query("products.list", { search: args.query as string }),
            )
          ).slice(0, 2),
        };
      },
    };
    const response = await runLiveLlm(
      client,
      ownerEndpoint,
      {
        kind: "chat",
        chatId: "1",
        turns: [{ role: "user", content: `Katalog prüfen. ${marker}` }],
      },
      tools,
      new AbortController().signal,
    );
    assert.equal(response.content, marker);
    assert.equal(response.usage.totalTokens, 30);
    const importRequest: LiveLlmRequest = {
      kind: "document_import",
      text: "Einlesen aus ausgewähltem Original",
      fileNames: [documentName],
      files: [
        {
          name: documentName,
          mime: "application/pdf",
          blob: new Blob([selectedOriginal]),
        },
      ],
    };
    const uploadFrames: number[] = [];
    let cancelUpload: AbortController | undefined;
    const browserSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(browserSocket, {
      construct(target, arguments_, newTarget) {
        const socket: WebSocket = Reflect.construct(
          target,
          arguments_,
          newTarget,
        );
        const send = socket.send.bind(socket);
        socket.send = (message) => {
          send(message);
          if (message instanceof ArrayBuffer) {
            uploadFrames.push(message.byteLength);
            cancelUpload?.abort();
          }
        };
        return socket;
      },
    });
    try {
      const imported = await runLiveLlm(
        client,
        ownerEndpoint,
        importRequest,
        tools,
        new AbortController().signal,
      );
      assert.equal(JSON.parse(imported.content).documentType, "deliveryNote");
      assert.deepEqual(uploadFrames, [blockBytes, blockBytes, 13]);
      assert.ok(checkedProviderOriginals > 0);

      uploadFrames.length = 0;
      cancelUpload = new AbortController();
      const callsBeforeCancellation = turns;
      await assert.rejects(
        runLiveLlm(client, ownerEndpoint, importRequest, tools, cancelUpload.signal),
        { name: "AbortError" },
      );
      assert.deepEqual(uploadFrames, [blockBytes]);
      assert.equal(turns, callsBeforeCancellation);
    } finally {
      globalThis.WebSocket = browserSocket;
    }
    console.log(
      "Live import sent the original in three bounded binary frames, verified the exact source bytes and stopped a cancelled upload before calling the model",
    );
    assert.equal(turns, 4);
    assert.equal(toolReplies, 2);

    const requests: { path: string; input: unknown }[] = [];
    const observed: Client = {
      ...business,
      query: ((path, input, options) => {
        requests.push({ path, input });
        return business.query(path, input, options);
      }) as Client["query"],
      mutate: ((path, input, options) => {
        requests.push({ path, input });
        return business.mutate(path, input, options);
      }) as Client["mutate"],
    };
    let seen: () => void = () => {};
    const published = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const subscription = business
      .streamQuery("deliveryNotes.scan.list", undefined)
      .subscribe(([rows, error]) => {
        assert.equal(error, null);
        if (rows?.some((row) => row.state === "completed")) seen();
      });
    try {
      const selected = new File(
        ["%PDF-1.7\n", marker],
        "Ausgewählter Lieferschein.pdf",
        { type: "application/pdf" },
      );
      const id = await processImport((signal, progress) =>
        readSelectedDocuments(
          observed,
          ownerEndpoint,
          [selected],
          signal,
          progress,
          {
            live: async (...args) => {
              const response = await runLiveLlm(...args);
              const recognized = JSON.parse(response.content).lines[0];
              await required(
                business.mutate("products.update", {
                  id: recognized.productId,
                  data: {
                    baseUnit: recognized.unit === "kg" ? "m" : "kg",
                    otherUnits: { [recognized.unit]: 2 },
                  },
                }),
              );
              const status = await required(
                client.query("zerotrust.status", undefined),
              );
              const authority = await openAuthority(client, status.profile);
              const current = record(
                await required(client.query("zerotrust.policy.get", undefined)),
                ["tenant", "version", "rules", "signature"],
              );
              const { signature: _signature, ...raw } = current;
              const previous = policy(raw);
              await required(
                client.mutate(
                  "zerotrust.policy.replace",
                  await signPolicy(
                    {
                      ...previous,
                      version: (BigInt(previous.version) + 1n).toString(),
                    },
                    authority,
                  ),
                ),
              );
              return response;
            },
          },
        ),
      );
      await published;
      assert.equal(llmActivity.snapshot().length, 0);
      const result = await required(
        business.mutate("deliveryNotes.scan.complete", { scanId: id }),
      );
      assert.equal(result.deliveryNote?.deliveryNumber, "LIVE-2026-1");
      assert.equal(result.deliveryNote?.records.length, 1);
      assert.equal(
        result.deliveryNote?.records[0]?.quantity,
        5,
        "Changed catalogue unit factors must be refreshed before saving the recognized quantity",
      );
      const fresh = createBusinessClient(client);
      try {
        const saved = await required(
          fresh.query("deliveryNotes.scan.list", undefined),
        );
        assert.equal(
          saved.find((row) => row.id === id)?.fileName,
          selected.name,
        );
        const reopened = await required(
          fresh.mutate("deliveryNotes.scan.complete", { scanId: id }),
        );
        assert.deepEqual(reopened, result);
      } finally {
        fresh.dispose();
      }
      const wire = JSON.stringify(requests);
      for (const plaintext of [
        marker,
        selected.name,
        "LIVE-2026-1",
        "Browserseitig erkannte Lieferposition",
      ])
        assert.equal(
          wire.includes(plaintext),
          false,
          "Scan result or source leaked into ordinary RPC input",
        );
      assert.equal(
        requests.some((request) =>
          [
            "deliveryNotes.scan.createUpload",
            "deliveryNotes.scan.start",
          ].includes(request.path),
        ),
        false,
      );
      console.log(
        "Actual import flow verified: selected original, browser checks, encrypted result commit, local history subscription and reopening through a fresh client.",
      );
    } finally {
      subscription.unsubscribe();
    }

    const failedFile = new File(["%PDF-1.7"], "Fehlversuch.pdf", {
      type: "application/pdf",
    });
    await assert.rejects(() =>
      processImport((signal, progress) =>
        readSelectedDocuments(
          business,
          ownerEndpoint,
          [failedFile],
          signal,
          progress,
          {
            live: async () => {
              throw new Error(marker);
            },
          },
        ),
      ),
    );
    const failedEntry = (
      await required(business.query("deliveryNotes.scan.list", undefined))
    ).find((row) => row.fileName === failedFile.name);
    assert.equal(failedEntry?.state, "failed");
    assert.equal(
      failedEntry?.error?.includes(marker),
      false,
      "Provider diagnostics must not enter durable failed-history messages",
    );
    assert.equal(llmActivity.snapshot().length, 0);

    let lost = false;
    const lostAcknowledgement: Client = {
      ...client,
      mutate: (async (path, input, options) => {
        const result = await client.mutate(path, input, options);
        if (path === "zerotrust.objects.batch" && !lost && !result[1]) {
          lost = true;
          return [null, new TypeError("Synthetic lost acknowledgement")];
        }
        return result;
      }) as Client["mutate"],
    };
    const privateHistory = await openPrivateLlm(
      lostAcknowledgement,
      new AbortController().signal,
    );
    try {
      const id = newAssistantId();
      await privateHistory.save("chat", id, { marker });
      assert.equal(lost, true);
      const original = (await privateHistory.list("chat")).find(
        (row) => row.id === id,
      )!;
      await privateHistory.save(
        "chat",
        id,
        { marker: "updated" },
        original.revision,
      );
      await assert.rejects(() =>
        privateHistory.save("chat", id, { marker: "stale" }, original.revision),
      );
      assert.deepEqual(
        (await privateHistory.list("chat")).find((row) => row.id === id)!.value,
        { marker: "updated" },
      );
      const largeId = newAssistantId(),
        large = "Verschlüsseltes Ergebnis ".repeat(100000);
      await privateHistory.save("chat", largeId, { text: large });
      assert.equal(
        (
          (await privateHistory.list("chat")).find((row) => row.id === largeId)!
            .value as { text: string }
        ).text,
        large,
      );
      console.log(
        "Private result persistence verified after a lost acknowledgement; stale edits cannot overwrite a newer revision, and encrypted batches above the ordinary 2 MiB JSON limit round-trip correctly.",
      );
    } finally {
      privateHistory.close();
    }

    await testLiveChats(client, business, ownerEndpoint, driver, chatFixture);
    await testChatDocuments(client, ownerEndpoint, driver, documentsFixture);

    const controller = new AbortController();
    const interrupted = runLiveLlm(
      client,
      ownerEndpoint,
      {
        kind: "chat",
        chatId: "2",
        turns: [{ role: "user", content: "LIVE_CANCEL" }],
      },
      tools,
      controller.signal,
    );
    await Promise.race([
      holdStarted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Provider did not start")), 10_000),
      ),
    ]);
    controller.abort();
    await assert.rejects(interrupted, { name: "AbortError" });
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(20);
    assert.equal(
      cancelled,
      true,
      "Closing the browser-owned request must drop the model HTTP response",
    );

    // A stolen session ticket alone cannot present the browser's signing proof.
    const account = unlockedAccount()!,
      history = await trustedHistory(client);
    const admission = await required(
      client.mutate("zerotrust.llm.open", {
        kind: "chat",
        chatId: "3",
        queries: [],
        mutations: [],
      }),
    );
    const raw = async (proof: string, peer?: string) => {
      const target = new URL("/llm/live", peer ?? endpoint);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(target);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Socket failed"));
      });
      const response = new Promise<Record<string, unknown>>((resolve) => {
        socket.onmessage = (event) => resolve(JSON.parse(event.data));
      });
      socket.send(JSON.stringify({ ticket: admission.ticket, proof }));
      const result = await response;
      socket.close();
      return result;
    };
    assert.equal((await raw("AAAAAAAA")).type, "error");
    const proof = await sign(
      account.identity.signingKey.privateKey,
      frame("sortsys/llm-live-browser/v1", [
        account.tenant,
        admission.subject,
        history.current.generation,
        await digest(bytes(admission.ticket)),
      ]),
    );
    assert.equal((await raw(proof)).type, "ready");
    assert.equal(
      (await raw(proof, options.peerEndpoint)).type,
      "error",
      "A consumed ticket cannot be reused on another connection or replica",
    );
    const heldSockets: WebSocket[] = [];
    async function reserve(peer: string) {
      const ticket = await required(
        client.mutate("zerotrust.llm.open", {
          kind: "chat",
          chatId: "4",
          queries: [],
          mutations: [],
        }),
      );
      const signature = await sign(
        account.identity.signingKey.privateKey,
        frame("sortsys/llm-live-browser/v1", [
          account.tenant,
          ticket.subject,
          history.current.generation,
          await digest(bytes(ticket.ticket)),
        ]),
      );
      const target = new URL("/llm/live", peer);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(target);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Reservation socket failed"));
      });
      const response = new Promise<Record<string, unknown>>((resolve) => {
        socket.onmessage = (event) => resolve(JSON.parse(event.data));
      });
      socket.send(JSON.stringify({ ticket: ticket.ticket, proof: signature }));
      const result = await response;
      if (result.type === "ready") heldSockets.push(socket);
      else socket.close();
      return result;
    }
    try {
      for (const peer of [endpoint, ownerEndpoint, endpoint, ownerEndpoint]) {
        assert.equal((await reserve(peer)).type, "ready");
      }
      assert.equal(
        (await reserve(ownerEndpoint)).type,
        "error",
        "The fifth request must be denied even when both API processes have local capacity",
      );
    } finally {
      for (const socket of heldSockets) socket.close();
    }
    console.log(
      "Live LLM verified: authenticated MCP, browser-only catalogue decryption, chunked originals, usage metadata, provider cancellation, identity proof, replay denial and a shared concurrent request limit.",
    );
    console.log("Live LLM replay also denied by an independent API replica.");
    await testMemberLlm(
      client,
      business,
      createClient(endpoint, "native-model-member"),
      driver,
      ownerEndpoint,
      memberFixture,
    );
  } catch (error) {
    console.error("Live test counters", { turns, toolReplies, cancelled });
    throw error;
  } finally {
    server.stop(true);
  }
}
