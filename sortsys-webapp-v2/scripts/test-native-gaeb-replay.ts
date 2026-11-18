import assert from "node:assert/strict";
import { initializeSharedField } from "@sortsys/gaeb";
import type { Client, QueryResult } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { required } from "../app/lib/data/protectedObjects";
import { gaebWorkflowXml } from "./test-live-gaeb-workflows";

type BusinessClient = ReturnType<typeof createBusinessClient>;

export async function prepareGaebReplay(owner: Client) {
  const { id: caseId } = await required(
    owner.mutate("commercial.cases.create", {
      kind: "offer",
      title: "Position mit gemeinsamem Zwischenstand",
      scopeItemIds: [],
    }),
  );
  const original = gaebWorkflowXml("83");
  const { id: document } = await required(
    owner.mutate("commercial.documents.create", {
      caseId,
      purpose: "inquiry",
      fileName: "Leistungsumfang.x83",
      xml: original,
      readOnly: false,
    }),
  );
  const room = {
    scope: `commercial:${caseId}`,
    document,
    facet: "scope" as const,
  };
  const signal = new AbortController().signal;
  const writer = await openDocumentMessages(owner, room, signal);
  const description = "Fensterlaibung für den Anstrich vorbereiten.";
  const data = initializeSharedField("item-1:text:0", description);
  const updated = original.replace("Fensterlaibung verputzen.", description);
  try {
    await writer.post("update", { facet: "scope", data });
    const page = await writer.read();
    await required(
      owner.mutate("commercial.documents.save", {
        caseId,
        id: document,
        version: 1n,
        xml: updated,
        livePositions: { scope: page.after },
        liveReplay: { scope: data },
      }),
    );
    return { caseId, document, room, data, xml: updated, covered: page.after };
  } finally {
    writer.close();
  }
}

export async function exerciseGaebReplayReceipt(
  owner: BusinessClient,
  peer: BusinessClient,
) {
  const { caseId, document, room, data, covered } =
    await prepareGaebReplay(owner);
  const signal = new AbortController().signal;
  const native = await peer.documents.open(caseId, document);
  assert.ok(native.liveTarget);
  const target = await native.liveTarget("scope");
  const reader = await openDocumentMessages(peer, room, signal);
  const wrongHash = base64(new Uint8Array(32).fill(79));
  try {
    const resume = await reader.resume(target);
    assert.deepEqual(resume, { position: covered, data });
    assert.deepEqual((await reader.read(covered)).messages, []);
    assert.equal(await reader.resume(wrongHash), undefined);
  } finally {
    reader.close();
  }
  const substituted: Client = {
    ...peer,
    query: (async (...args: Parameters<Client["query"]>) => {
      const reply = await peer.query(...args);
      if (args[0] === "zerotrust.documents.messages.state" && !reply[1]) {
        const state = reply[0] as QueryResult<"zerotrust.documents.messages.state">;
        assert.ok(state?.checkpoint?.replay);
        return [
          {
            ...state,
            checkpoint: {
              ...state.checkpoint,
              replay: { ...state.checkpoint.replay, hash: wrongHash },
            },
          },
          null,
        ];
      }
      return reply;
    }) as Client["query"],
  };
  const untrusted = await openDocumentMessages(substituted, room, signal);
  try {
    await assert.rejects(() => untrusted.resume(target));
    assert.equal((await untrusted.read()).after, covered);
  } finally {
    untrusted.close();
  }
  console.log("GAEB replay receipt crosses replicas and rejects a substituted manifest");
}

export async function checkGaebReplayAfterRestore(
  peer: BusinessClient,
  fixture: Awaited<ReturnType<typeof prepareGaebReplay>>,
  content: string,
) {
  const { caseId, document, room, data, covered, xml } = fixture;
  const signal = new AbortController().signal;
  const native = await peer.documents.open(caseId, document, signal);
  assert.ok(native.liveTarget);
  const target = await native.liveTarget("scope");
  const state = await required(
    peer.query("zerotrust.documents.messages.state", room, {
      strategy: "network-only",
    }),
  );
  assert.equal(state.content, content);
  assert.ok(state.checkpoint?.replay);
  assert.notEqual(state.checkpoint.content, content);
  const original = await openDocumentMessages(peer, room, signal);
  try {
    assert.equal(await original.resume(target), undefined);
    assert.equal((await original.read()).after, covered);
  } finally {
    original.close();
  }

  // The restored XML is already current. Confirm a new replay pointer under
  // the active content head without inventing another native revision.
  const saved = await required(
    peer.mutate("commercial.documents.save", {
      caseId,
      id: document,
      version: native.version,
      xml,
      livePositions: { scope: `${content}:${covered}` },
      liveReplay: { scope: data },
    }),
  );
  assert.equal(saved.version, native.version);
  const regenerated = await openDocumentMessages(peer, room, signal);
  try {
    assert.deepEqual(await regenerated.resume(target), {
      position: covered,
      data,
    });
  } finally {
    regenerated.close();
  }
  console.log(
    "GAEB replay falls back to the log after restore and can be confirmed for the new content epoch",
  );
}
