import assert from "node:assert/strict";
import {
  createClient,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import { base64, randomSecret, record } from "@sortsys/zerotrust/sortsys";
import {
  createGaebXml,
  initializeSharedField,
  InvalidSharedUpdate,
  mergeSharedUpdates,
  SharedFields,
} from "@sortsys/gaeb";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { required } from "../app/lib/data/protectedObjects";
import type { DuckDriver } from "../app/lib/data/database";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";
import { watchEncryptedEvents } from "../app/lib/data/events";
import { listenDocumentMessages } from "../app/lib/data/documentMessageHints";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";

type PostedMessage = MutateInput<"zerotrust.documents.messages.post">;

/** Real database acceptance across independent API processes; browser tests
 * separately exercise the complete editor-side connection controller. */
export async function testDocumentMessages(
  client: Client,
  driver: () => Promise<DuckDriver>,
  password: string,
) {
  const owner = unlockedAccount()!;
  const peer = createClient(
    process.env.SORTSYS_LLM_TEST_PEER!,
    "native-document-messages",
  );
  await signIn(peer, {
    tenant: owner.tenant,
    username: owner.username,
    password,
  });
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const signal = new AbortController().signal;
  const eventsLifetime = new AbortController();
  let eventStream: Promise<void> | undefined;
  let stopHints: (() => void) | undefined;
  let lostUpdateReply = false;
  let lostPresenceReply = false;
  const messages: PostedMessage[] = [];
  let beforePublication: (() => Promise<void>) | undefined;
  let losePublicationReply = false;
  const observed: Client = {
    ...client,
    mutate: (async (path, input, options) => {
      if (path === "zerotrust.documents.messages.post") {
        messages.push(input as PostedMessage);
      }
      if (path === "zerotrust.objects.batch" && beforePublication) {
        const publish = beforePublication;
        beforePublication = undefined;
        await publish();
      }
      const reply = await client.mutate(path, input, options);
      if (
        path === "zerotrust.objects.batch" &&
        losePublicationReply &&
        !reply[1]
      ) {
        losePublicationReply = false;
        return [null, new Error("Synthetic lost native publication receipt")];
      }
      const packet = input as PostedMessage;
      if (path === "zerotrust.documents.messages.post" && !reply[1]) {
        if (packet.kind === "update" && !lostUpdateReply) {
          lostUpdateReply = true;
          return [null, new Error("Synthetic lost update receipt")];
        }
        if (packet.kind === "presence" && !lostPresenceReply) {
          lostPresenceReply = true;
          return [null, new Error("Synthetic lost presence receipt")];
        }
      }
      return reply;
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, {
    productDriver: driver,
    gaebProcessor: gaebTestProcessor,
  });
  let first: Awaited<ReturnType<typeof openDocumentMessages>> | undefined;
  let second: Awaited<ReturnType<typeof openDocumentMessages>> | undefined;
  try {
    const offer = await required(
      business.mutate("commercial.cases.create", {
        kind: "offer",
        title: "Zusammenarbeit 827491",
        scopeItemIds: [],
      }),
    );
    const xml = createGaebXml("84", "Zusammenarbeit 827491", "2026-11-12");
    const document = await required(
      business.mutate("commercial.documents.create", {
        caseId: offer.id,
        purpose: "offer",
        fileName: "Angebot.x84",
        xml,
        netAmount: "0.00",
        readOnly: false,
      }),
    );
    const room = {
      scope: `commercial:${offer.id}`,
      document: document.id,
      facet: "scope" as const,
    };
    const selections = [
      { room, after: "0" },
      { room: { ...room, facet: "billing" }, after: "0" },
    ];
    const emptyPages = await required(
      peer.query("zerotrust.documents.messages.pages", { selections }),
    );
    assert.equal(emptyPages.length, 2);
    for (const page of emptyPages) {
      assert.deepEqual(page, {
        messages: [],
        presence: [],
        after: "0",
        more: false,
      });
    }
    for (const invalid of [
      [],
      Array.from({ length: 5 }, () => selections[0]),
      [selections[0], { room, after: "-1" }],
      [selections[0], { room: { ...room, document: "1" }, after: "0" }],
    ]) {
      const [data, error] = await peer.query(
        "zerotrust.documents.messages.pages",
        {
          selections: invalid,
        },
      );
      assert.equal(data, null);
      assert.ok(
        error,
        "An invalid or inaccessible channel must reject the entire batch",
      );
    }
    const initialDocument = await required(
      business.query("commercial.documents.get", {
        caseId: offer.id,
        id: document.id,
      }),
    );
    let eventsReady = false;
    let roomHintReceived = false;
    stopHints = listenDocumentMessages(peer, (hint) => {
      if (hint.scope === room.scope && hint.document === room.document) {
        roomHintReceived = true;
      }
    });
    eventStream = watchEncryptedEvents(
      peer,
      process.env.SORTSYS_LLM_TEST_PEER!,
      () => {
        eventsReady = true;
      },
      eventsLifetime.signal,
    );
    async function waitFor(condition: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error("Encrypted document notification timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await waitFor(() => eventsReady);
    first = await openDocumentMessages(observed, room, signal);
    second = await openDocumentMessages(peer, room, signal);
    const field = "document:title";
    const original = "Zusammenarbeit 827491";
    assert.ok(xml.includes(encodeURIComponent(original)));
    await first.post("initialize", {
      facet: "scope",
      field,
      value: original,
      data: initializeSharedField(field, "Beschädigter Ausgangszustand"),
    });
    await Promise.all([
      first.post("initialize", {
        facet: "scope",
        field,
        value: original,
        data: initializeSharedField(field, original),
      }),
      second.post("initialize", {
        facet: "scope",
        field,
        value: original,
        data: initializeSharedField(field, original),
      }),
    ]);
    const initial = await first.read();
    await waitFor(() => roomHintReceived);
    assert.equal(
      initial.messages.length,
      3,
      "Independent candidates survive across API replicas",
    );
    assert.equal(
      new Set(initial.messages.map((message) => message.key)).size,
      3,
    );
    const initializedSave = await required(
      business.mutate("commercial.documents.save", {
        caseId: offer.id,
        id: document.id,
        version: initialDocument.version,
        xml,
        netAmount: "0.00",
        livePositions: { scope: initial.after },
      }),
    );
    assert.equal(initializedSave.version, initialDocument.version);
    const initialLiveState = await required(
      peer.query("zerotrust.documents.messages.state", room, {
        strategy: "network-only",
      }),
    );
    assert.equal(initialLiveState.current, initial.after);
    assert.equal(initialLiveState.checkpoint?.covered, initial.after);
    const peers = [new SharedFields(), new SharedFields()];
    try {
      const updates: string[][] = [[], []];
      for (const [index, shared] of peers.entries()) {
        shared.enableFacets();
        shared.register(
          new Map([
            [
              field,
              {
                key: field,
                value: original,
                editable: true,
                multiline: true,
                label: "Titel",
                commit() {},
              },
            ],
          ]),
        );
        let accepted = 0;
        let rejected = 0;
        for (const message of initial.messages) {
          const candidate = record((await first.open(message)).value, [
            "facet",
            "field",
            "value",
            "data",
          ]);
          assert.equal(candidate.facet, "scope");
          try {
            if (
              shared.receiveInitialization(
                candidate.field as string,
                candidate.value as string,
                candidate.data as string,
              )
            ) {
              accepted += 1;
            }
          } catch (error) {
            if (!(error instanceof InvalidSharedUpdate)) {
              throw error;
            }
            rejected += 1;
          }
        }
        assert.equal(
          rejected,
          1,
          "A signed invalid initializer is rejected by each recipient",
        );
        assert.equal(
          accepted,
          1,
          "The first valid candidate wins in both API connections",
        );
        assert.equal(shared.value(field), original);
        shared.connect((message) => {
          if (message.type === "update") {
            updates[index]!.push(message.data as string);
          }
        }, true);
        updates[index]!.length = 0;
      }
      peers[0]!.edit(field, original, `${original} Dach 629481`);
      peers[1]!.edit(field, original, `${original} Fenster 9326481`);
      await Promise.all([
        first.post("update", { facet: "scope", data: updates[0]![0] }),
        second.post("update", { facet: "scope", data: updates[1]![0] }),
      ]);
      const changed = await second.read(initial.after);
      assert.equal(changed.messages.length, 2);
      assert.ok(
        BigInt(changed.messages[0]!.sequence) <
          BigInt(changed.messages[1]!.sequence),
      );
      for (const message of changed.messages) {
        const update = record((await second.open(message)).value, [
          "facet",
          "data",
        ]);
        assert.equal(update.facet, "scope");
        for (const shared of peers) {
          shared.receive(update.data as string);
        }
      }
      assert.equal(peers[0]!.value(field), peers[1]!.value(field));
      assert.ok(peers[0]!.value(field)?.includes("Dach"));
      assert.ok(peers[0]!.value(field)?.includes("Fenster"));

      async function currentNative() {
        return required(
          business.query("commercial.documents.get", {
            caseId: offer.id,
            id: document.id,
          }),
        );
      }
      async function livePosition() {
        const state = await required(
          peer.query("zerotrust.documents.messages.state", room, {
            strategy: "network-only",
          }),
        );
        return state.current;
      }
      function nativeXml() {
        // This fixture edits only its known generated project label. The real
        // browser editor uses GaebDocument, which requires browser DOM APIs.
        return xml.replaceAll(
          encodeURIComponent(original),
          encodeURIComponent(peers[0]!.value(field)!),
        );
      }
      async function saveNative(
        version: bigint,
        source: string,
        liveSequence?: string,
      ) {
        return business.mutate("commercial.documents.save", {
          caseId: offer.id,
          id: document.id,
          version,
          xml: source,
          netAmount: "0.00",
          livePositions:
            liveSequence === undefined ? undefined : { scope: liveSequence },
        });
      }
      async function anotherEdit(suffix: string) {
        const before = peers[1]!.value(field)!;
        peers[1]!.edit(field, before, before + suffix);
        const update = updates[1]!.at(-1)!;
        await second!.post("update", { facet: "scope", data: update });
        peers[0]!.receive(update);
      }

      console.log("Native live documents: concurrent native publication");
      assert.ok(
        (await saveNative(initialDocument.version, nativeXml()))[1],
        "A native save cannot ignore accepted live edits",
      );
      const beforeRace = await livePosition();
      const beforeRaceXml = nativeXml();
      beforePublication = () => anotherEdit(" Tür 728491");
      assert.ok(
        (
          await saveNative(initialDocument.version, beforeRaceXml, beforeRace)
        )[1],
        "An edit accepted by the other API before commit invalidates the prepared publication",
      );
      assert.equal(
        beforePublication,
        undefined,
        "The race must reach the actual publication boundary",
      );
      assert.equal(
        (await currentNative()).xml,
        xml,
        "A rejected publication changes no native content",
      );
      assert.equal(
        (
          await required(
            peer.query("zerotrust.documents.messages.state", room, {
              strategy: "network-only",
            }),
          )
        ).checkpoint?.signature,
        initialLiveState.checkpoint?.signature,
      );

      const saved = await required(
        saveNative(initialDocument.version, nativeXml(), await livePosition()),
      );
      const durableXml = nativeXml();
      assert.equal((await currentNative()).xml, durableXml);
      const published = await required(
        peer.query("zerotrust.documents.messages.state", room, {
          strategy: "network-only",
        }),
      );
      assert.equal(published.checkpoint?.covered, published.current);

      // A text insertion followed by its removal still advances the CRDT log.
      // Confirming identical XML must not invent another native file version.
      const title = peers[0]!.value(field)!;
      console.log(
        "Native live documents: equivalent XML checkpoint and lost receipt",
      );
      const firstUndoUpdate = updates[0]!.length;
      peers[0]!.edit(field, title, title + " Temporär 827491");
      peers[0]!.edit(field, title + " Temporär 827491", title);
      const undone = mergeSharedUpdates(updates[0]!.slice(firstUndoUpdate));
      await first!.post("update", { facet: "scope", data: undone });
      peers[1]!.receive(undone);
      losePublicationReply = true;
      const confirmed = await required(
        saveNative(saved.version, durableXml, await livePosition()),
      );
      assert.equal(losePublicationReply, false);
      assert.equal(confirmed.version, saved.version);
      const afterUndo = await required(
        peer.query("zerotrust.documents.messages.state", room, {
          strategy: "network-only",
        }),
      );
      assert.equal(afterUndo.checkpoint?.covered, afterUndo.current);

      const nativeStore = await commercialDocumentStore(
        observed,
        room.scope,
        signal,
      );
      try {
        console.log("Native live documents: concurrent final lock");
        const head = (await nativeStore.head(document.id))!;
        const lock = await nativeStore.lock(head, new Date().toISOString());
        beforePublication = () => anotherEdit(" Gerüst 928471");
        await assert.rejects(() => nativeStore.publish(lock));
        assert.equal(beforePublication, undefined);
        assert.equal((await nativeStore.head(document.id))!.locked, false);
        assert.equal((await currentNative()).xml, durableXml);
        assert.ok(afterUndo.checkpoint);
        const [, replayError] = await peer.mutate("zerotrust.objects.batch", {
          objects: [],
          heads: [],
          documents: [lock.head],
          liveCheckpoints: [afterUndo.checkpoint],
        });
        assert.ok(
          replayError,
          "An existing receipt cannot freeze later unseen text updates",
        );
        assert.ok("code" in replayError);
        assert.equal(replayError.code, "CONFLICT");
        assert.equal((await nativeStore.head(document.id))!.locked, false);

        const included = await required(
          saveNative(confirmed.version, nativeXml(), await livePosition()),
        );
        // Reload the publication's read prerequisites after the rejected
        // transaction and the subsequent save through the business adapter.
        const refreshedStore = await commercialDocumentStore(
          observed,
          room.scope,
          signal,
        );
        try {
          const current = (await refreshedStore.head(document.id))!;
          assert.equal(BigInt(current.version), included.version);
          await refreshedStore.publish(
            await refreshedStore.lock(current, new Date().toISOString()),
          );
          assert.equal((await refreshedStore.head(document.id))!.locked, true);
        } finally {
          refreshedStore.close();
        }
        assert.equal((await currentNative()).frozen, true);
        assert.equal((await currentNative()).xml, nativeXml());
        await assert.rejects(() =>
          first!.post("update", { facet: "scope", data: undone }),
        );
      } finally {
        nativeStore.close();
      }
    } finally {
      for (const shared of peers) {
        shared.destroy();
      }
    }
    // Base64url channel tokens may begin with punctuation. Storage keys must
    // prefix them instead of rejecting an otherwise valid encrypted message.
    const presence = `_${base64(randomSecret()).slice(1)}`;
    await first.post(
      "presence",
      {
        facet: "scope",
        name: "Vertrauliche Bearbeiterin 738491",
        selection: { field, start: 3, end: 6 },
        left: false,
      },
      presence,
      "1",
    );
    assert.equal((await second.read(initial.after)).presence.length, 1);
    assert.equal(lostUpdateReply, true);
    assert.equal(lostPresenceReply, true);
    await assert.rejects(() =>
      first!.post(
        "presence",
        { facet: "scope", name: "Replay", selection: { field }, left: false },
        presence,
        "1",
      ),
    );
    const forged = structuredClone(messages[0]!);
    forged.envelope.author = "user:2";
    assert.ok(
      (await client.mutate("zerotrust.documents.messages.post", forged))[1],
    );
    console.log(
      "Native live documents: project-file publication and metadata coverage",
    );
    const project = await required(
      business.mutate("projects.create", {
        title: "Dateizusammenarbeit 617294",
      }),
    );
    const fileId = await business.files.upload({
      projectId: project.id,
      name: "Aufmaß.x31",
      mime: "application/vnd.gaeb+xml",
      blob: new Blob([createGaebXml("31", "Dateizusammenarbeit 617294")], {
        type: "application/xml",
      }),
    });
    const fileRoom = {
      scope: `project:${project.id}`,
      document: fileId,
      facet: "attachment" as const,
    };
    const fileMessages = await openDocumentMessages(peer, fileRoom, signal);
    try {
      const initialFile = await required(
        business.query("projects.files.xmlContent", {
          projectId: project.id,
          fileId,
        }),
      );
      const fileUpdate = initializeSharedField(
        "document:title",
        "Bearbeitetes Aufmaß 713294",
      );
      await fileMessages.post("update", { facet: "scope", data: fileUpdate });
      const editedFile = initialFile.xml.replaceAll(
        encodeURIComponent("Dateizusammenarbeit 617294"),
        encodeURIComponent("Bearbeitetes Aufmaß 713294"),
      );
      async function saveFile(version: bigint, liveSequence?: string) {
        return business.mutate("projects.files.xmlSave", {
          projectId: project.id,
          fileId,
          version,
          xml: editedFile,
          liveSequence,
        });
      }
      const position = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      assert.ok((await saveFile(initialFile.version))[1]);
      beforePublication = async () => {
        await fileMessages.post("update", { facet: "scope", data: fileUpdate });
      };
      assert.ok((await saveFile(initialFile.version, position.current))[1]);
      assert.equal(beforePublication, undefined);
      const rejected = await required(
        business.query("projects.files.xmlContent", {
          projectId: project.id,
          fileId,
        }),
      );
      assert.equal(rejected.version, initialFile.version);
      assert.equal(rejected.xml, initialFile.xml);
      const racedPosition = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      assert.equal(racedPosition.checkpoint, null);
      const accepted = await required(
        saveFile(initialFile.version, racedPosition.current),
      );
      await fileMessages.post("update", { facet: "scope", data: fileUpdate });
      const noOpPosition = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      const noOp = await required(
        saveFile(accepted.version, noOpPosition.current),
      );
      assert.equal(noOp.version, accepted.version);
      const confirmedFile = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      assert.equal(confirmedFile.checkpoint?.covered, confirmedFile.current);
      await fileMessages.post("update", { facet: "scope", data: fileUpdate });
      await required(
        business.mutate("projects.files.rename", {
          projectId: project.id,
          fileId,
          fileName: "Umbenanntes Aufmaß.x31",
        }),
      );
      const renamed = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      assert.equal(
        renamed.checkpoint?.covered,
        confirmedFile.current,
        "Renaming must not claim that later live edits were incorporated",
      );
      assert.equal(renamed.checkpoint?.sequence, renamed.current);
      assert.notEqual(renamed.current, confirmedFile.current);
      await required(saveFile(noOp.version, renamed.current));
      const beforeBurst = await required(
        peer.query("zerotrust.documents.messages.state", fileRoom, {
          strategy: "network-only",
        }),
      );
      for (let batch = 0; batch < 4; batch++) {
        await Promise.all(
          Array.from({ length: 9 }, () =>
            fileMessages.post("update", { facet: "scope", data: fileUpdate }),
          ),
        );
      }
      const firstPage = await fileMessages.read(beforeBurst.current);
      assert.equal(firstPage.messages.length, 32);
      assert.equal(firstPage.more, true);
      const secondPage = await fileMessages.read(firstPage.after);
      assert.equal(secondPage.messages.length, 4);
      assert.equal(secondPage.more, false);
      const sequences = [...firstPage.messages, ...secondPage.messages].map(
        (message) => BigInt(message.sequence),
      );
      assert.deepEqual(
        sequences,
        Array.from(
          { length: 36 },
          (_, index) => BigInt(beforeBurst.current) + BigInt(index + 1),
        ),
      );
    } finally {
      fileMessages.close();
    }
    for (const secret of [
      original,
      field,
      "Vertrauliche Bearbeiterin",
      "Fenster",
      "Dach",
    ]) {
      assert.equal(JSON.stringify(messages).includes(secret), false);
    }
    console.log(
      "NATIVE_DOCUMENT_MESSAGES_OK: commercial and project-file publication races, atomic locks, no-op checkpoints, lost receipts, cross-API live edits, private presence and forged author rejection.",
    );
    const finalCommercial = await required(
      business.query("commercial.documents.get", {
        caseId: offer.id,
        id: document.id,
      }),
    );
    const finalFile = await required(
      business.query("projects.files.xmlContent", {
        projectId: project.id,
        fileId,
      }),
    );
    return {
      commercial: {
        caseId: offer.id,
        documentId: document.id,
        xml: finalCommercial.xml,
      },
      file: { projectId: project.id, fileId, xml: finalFile.xml },
    };
  } finally {
    eventsLifetime.abort();
    stopHints?.();
    await eventStream;
    first?.close();
    second?.close();
    business.dispose();
    peer.setToken(null);
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  }
}
