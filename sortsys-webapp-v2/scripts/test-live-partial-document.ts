import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { documentPartTarget, signLiveCheckpoint } from "@sortsys/zerotrust/sortsys";
import { initializeSharedField } from "@sortsys/gaeb";
import {
  acceptVaultWithKey,
  trustedHistory,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { required } from "../app/lib/data/protectedObjects";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { prepareLivePublication } from "../app/lib/data/liveCheckpoints";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";

/** Use an ordinary member with only master-data read and scope update rights.
 * Neither partial edits nor public log state may expose financial keys. */
export async function testPartialNativeDocument(
  owner: { client: Client; account: UnlockedAccount },
  member: { client: Client; account: UnlockedAccount },
  caseId: string,
  documentId: string,
  driver: () => Promise<DuckDriver>,
) {
  const signal = new AbortController().signal;
  const scope = `commercial:${caseId}`;
  const room = { scope, document: documentId, facet: "scope" as const };
  const originalText = "Fensteranschlüsse private Abrechnung 762481";
  const changedText = "Geänderter Positionstext ohne Preisfreigabe 938461";
  let originalXml = "";
  let nextHead;
  let verifiedVersion = "";
  try {
    await acceptVaultWithKey(owner.account.dataKey, owner.account.vault, owner.account.username, false);
    const originalStore = await commercialDocumentStore(
      owner.client,
      scope,
      signal,
    );
    try {
      const head = await originalStore.head(documentId);
      assert.ok(head);
      originalXml = (await originalStore.load(head, gaebTestProcessor)).xml;
      assert.ok(originalXml.includes(`<span>${originalText}</span>`));
    } finally {
      originalStore.close();
    }

    await acceptVaultWithKey(member.account.dataKey, member.account.vault, member.account.username, false);
    const memberStore = await commercialDocumentStore(
      member.client,
      scope,
      signal,
    );
    const business = createBusinessClient(member.client, {
      productDriver: driver,
      gaebProcessor: gaebTestProcessor,
    });
    try {
      const head = await memberStore.head(documentId);
      assert.ok(head);
      const view = await memberStore.load(head, gaebTestProcessor);
      assert.equal(view.complete, false);
      assert.equal(view.access.complete, false);
      assert.deepEqual(view.access.readable, ["scope"]);
      assert.deepEqual(view.access.writable, ["scope"]);
      assert.ok(view.missing.includes("billing"));
      assert.equal(view.xml.includes("<UP>"), false);
      assert.equal(view.xml.includes("95.20"), false);
      assert.ok(view.xml.includes(originalText));
      const state = await required(
        member.client.query("zerotrust.documents.messages.state", room),
      );
      assert.equal(state.current, "0");
      assert.ok(
        (
          await member.client.query("zerotrust.documents.messages.read", {
            room: { ...room, facet: "billing" },
            after: "0",
          })
        )[1],
      );
      const source = view.xml.replace(
        `<span>${originalText}</span>`,
        `<span>${changedText}</span>`,
      );
      const editor = await business.documents.open(caseId, documentId);
      assert.equal(editor.canEdit, true);
      assert.equal(editor.contentView?.access.complete, false);
      assert.equal(editor.contentView?.canRename, false);
      assert.ok(!editor.xml.includes("95.20"));
      assert.equal((await editor.contentView!.validate(source)).valid, true);
      const saved = await required(
        business.mutate("commercial.documents.save", {
          caseId,
          id: documentId,
          version: editor.version,
          xml: source,
        }),
      );
      const publicationHead = await memberStore.head(documentId);
      assert.ok(publicationHead);
      assert.equal(BigInt(publicationHead.version), saved.version);
      for (const part of head.parts) {
        if (part.facet !== "scope") {
          assert.deepEqual(
            publicationHead.parts.find(
              (candidate) => candidate.facet === part.facet,
            ),
            part,
          );
        }
      }
      verifiedVersion = publicationHead.version;
      assert.equal(BigInt(verifiedVersion), BigInt(head.version) + 1n);
      const updated = await memberStore.load(
        publicationHead,
        gaebTestProcessor,
      );
      assert.ok(updated.xml.includes(changedText));
      assert.equal(updated.xml.includes("95.20"), false);
      await assert.rejects(() =>
        memberStore.prepareView(
          documentId,
          updated.xml.replace("</Item>", "<UP>0.000</UP></Item>"),
          "invoice",
          gaebTestProcessor,
          {
            previous: publicationHead,
            modifiedAt: new Date().toISOString(),
            locked: false,
          },
        ),
      );
      const later = await memberStore.prepareView(
        documentId,
        updated.xml.replace(changedText, "Unbestätigter weiterer Text"),
        "invoice",
        gaebTestProcessor,
        {
          previous: publicationHead,
          modifiedAt: new Date().toISOString(),
          locked: false,
        },
      );
      nextHead = later.head;
    } finally {
      business.dispose();
      memberStore.close();
    }

    await acceptVaultWithKey(owner.account.dataKey, owner.account.vault, owner.account.username, false);
    const fullStore = await commercialDocumentStore(
      owner.client,
      scope,
      signal,
    );
    try {
      const head = await fullStore.head(documentId);
      assert.ok(head);
      const content = await fullStore.load(head, gaebTestProcessor);
      assert.equal(content.complete, true);
      assert.equal(
        content.xml,
        originalXml.replace(
          `<span>${originalText}</span>`,
          `<span>${changedText}</span>`,
        ),
      );
      assert.equal(
        (
          await gaebTestProcessor.validate(
            content.xml,
            content.layout.identity,
            signal,
          )
        ).valid,
        true,
      );
    } finally {
      fullStore.close();
    }
    const writer = await openDocumentMessages(owner.client, room, signal);
    try {
      await writer.post("initialize", {
        facet: "scope",
        field: "project:title",
        value: originalText,
        data: initializeSharedField("project:title", originalText),
      });
    } finally {
      writer.close();
    }

    await acceptVaultWithKey(member.account.dataKey, member.account.vault, member.account.username, false);
    const state = await required(
      member.client.query("zerotrust.documents.messages.state", room),
    );
    const history = await trustedHistory(member.client);
    const policy = await required(
      member.client.query("zerotrust.policy.get", undefined),
    );
    const session = await required(
      member.client.query("auth.sessionInfo", undefined),
    );
    assert.ok(nextHead);
    const forged = await signLiveCheckpoint(
      {
        tenant: member.account.tenant,
        ...room,
        facet: "billing",
        target: await documentPartTarget(nextHead, "billing"),
        sequence: state.current,
        covered: state.current,
        generation: history.current.generation,
        policyVersion: policy.version,
        author: `user:${session.user.id}`,
      },
      unlockedAccount()!.identity.signingKey.privateKey,
    );
    const [result, error] = await member.client.mutate(
      "zerotrust.objects.batch",
      {
        objects: [],
        heads: [],
        documents: [nextHead],
        liveCheckpoints: [forged],
      },
    );
    assert.ok(
      error,
      "A scope writer cannot attest to unread private live layers",
    );
    assert.ok("code" in error);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(result, null);

    await acceptVaultWithKey(member.account.dataKey, member.account.vault, member.account.username, false);
    const checkedStore = await commercialDocumentStore(
      member.client,
      scope,
      signal,
    );
    try {
      const head = await checkedStore.head(documentId);
      assert.ok(head);
      assert.equal(
        head.version,
        verifiedVersion,
        "Rejected coverage cannot publish even an otherwise permitted native scope edit",
      );
      const textChannel = await openDocumentMessages(
        member.client,
        room,
        signal,
      );
      let covered;
      try {
        const page = await textChannel.read();
        assert.ok(page.messages.some((entry) => entry.kind === "initialize"));
        for (const entry of page.messages) {
          await textChannel.open(entry);
        }
        assert.equal(textChannel.canWrite, true);
        await textChannel.post("initialize", {
          facet: "scope",
          field: "project:title",
          value: originalText,
          data: initializeSharedField("project:title", originalText),
        });
        covered = (await textChannel.read()).after;
        assert.ok(BigInt(covered) > BigInt(state.current));
      } finally {
        textChannel.close();
      }
      const target = await documentPartTarget(head, "scope");
      const checkpoint = await prepareLivePublication(
        member.client,
        room,
        target,
        target,
        signal,
        { sequence: covered },
      );
      assert.ok(checkpoint);
      await commitProtectedWrites(member.client, [], signal, [], {
        live: [checkpoint],
      });
      const confirmed = await required(
        member.client.query("zerotrust.documents.messages.state", room),
      );
      assert.equal(confirmed.checkpoint?.author, `user:${session.user.id}`);
      assert.equal(confirmed.checkpoint?.covered, covered);
    } finally {
      checkedStore.close();
    }
    return BigInt(verifiedVersion);
  } finally {
    await acceptVaultWithKey(owner.account.dataKey, owner.account.vault, owner.account.username, false);
  }
}
