import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { PRINT_COLLECTION } from "../app/lib/data/organizationData";
import {
  PRINT_OBJECT,
  printTemplatePayload,
  readTemplateResource,
  type PrintTemplatePayload,
} from "../app/lib/data/printTemplateData";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

type BusinessClient = ReturnType<typeof createBusinessClient>;

async function unlock(account: UnlockedAccount) {
  await acceptVaultWithKey(
    account.dataKey,
    account.vault,
    account.username,
    false,
  );
}

async function assertAssets(
  business: BusinessClient,
  source: string,
  originals: ReadonlyMap<string, Uint8Array>,
) {
  const template = await required(
    business.query("settings.documentTemplate.get", undefined),
  );
  assert.equal(template.source, source);
  assert.equal(template.assets.length, originals.size);
  for (const asset of template.assets) {
    const reference = readTemplateResource(asset.downloadUrl!);
    const blob = await business.templates.blob(reference.id, reference.version);
    assert.deepEqual(
      new Uint8Array(await blob.arrayBuffer()),
      originals.get(asset.name),
    );
  }
  return template;
}

/** Real encrypted template and asset workflows against two independent API
 * replicas. No plaintext upload endpoint or mocked business service is used. */
export async function exerciseNativePrintTemplates(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const sent: { path: string; input: unknown }[] = [];
  let discardMetadata = false;
  let loseReply = false;
  const observed: Client = {
    ...owner,
    query: ((path, input, options) => {
      sent.push({ path, input: structuredClone(input) });
      return owner.query(path, input, options);
    }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input: structuredClone(input) });
      if (path === "zerotrust.objects.batch" && discardMetadata) {
        return [{ success: true }, null];
      }
      const reply = await owner.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && loseReply && !reply[1]) {
        loseReply = false;
        return [null, new Error("Lost template publication acknowledgement")];
      }
      return reply;
    }) as Client["mutate"],
  };
  let business = createBusinessClient(observed, { productDriver: duckDriver });
  let colleague = createBusinessClient(peer, { productDriver: duckDriver });
  const originals = new Map<string, Uint8Array<ArrayBuffer>>();
  let source =
    "// Vertraulicher Typst-Musterkopf 48931\n#let briefkopf = [Bau und Handwerk]\n";
  try {
    const status = await required(
      owner.query("zerotrust.status", undefined, {
        strategy: "network-only",
      }),
    );
    const initialized = status.initialization;
    assert.ok(initialized);
    assert.ok(initialized.objects.includes(PRINT_OBJECT));
    const initial = await required(
      business.query("settings.documentTemplate.get", undefined),
    );
    await required(
      business.mutate("settings.documentTemplate.set", {
        source,
        expectedRevision: initial.revision,
      }),
    );
    for (const asset of [
      {
        name: "Musterlogo-48931.png",
        mime: "image/png",
        file: new URL("../public/icon-black-192x192.png", import.meta.url),
      },
      {
        name: "Musterbriefpapier-48931.pdf",
        mime: "application/pdf",
        file: new URL(
          "../../sortsys-api-v2/test-files/searchable-project-document.pdf",
          import.meta.url,
        ),
      },
    ]) {
      const bytes = new Uint8Array(await Bun.file(asset.file).arrayBuffer());
      await business.templates.upload(
        new File([bytes], asset.name, { type: asset.mime }),
      );
      originals.set(asset.name, bytes);
    }
    const loaded = await assertAssets(colleague, source, originals);
    const initialization = await initializeTenant(owner, signal, duckDriver);
    assert.equal(initialization.signature, initialized.signature);
    await assertAssets(business, source, originals);
    const asset = loaded.assets[0]!;
    const reference = readTemplateResource(asset.downloadUrl!);
    const collection = await protectedCollection(
      owner,
      PRINT_COLLECTION,
      signal,
    );
    let original: PrintTemplatePayload;
    try {
      original = printTemplatePayload(
        (await collection.read())[0]!.value,
        PRINT_OBJECT,
      );
    } finally {
      collection.close();
    }
    async function publish(payload: PrintTemplatePayload) {
      const collection = await protectedCollection(
        owner,
        PRINT_COLLECTION,
        signal,
      );
      try {
        const previous = (await collection.read())[0]!;
        const packet = await collection.packet(
          PRINT_OBJECT,
          payload,
          previous.envelope,
        );
        await commitProtectedWrites(
          owner,
          [
            {
              packets: [packet],
              head: {
                domain: PRINT_COLLECTION.domain,
                sequence: collection.snapshot()!,
              },
              async verify() {
                return (
                  (await collection.read())[0]?.envelope.signature ===
                  packet.envelope.signature
                );
              },
              close() {},
            },
          ],
          signal,
        );
      } finally {
        collection.close();
      }
    }
    const corrupt = structuredClone(original);
    corrupt.assets[0]!.content.parts[0]!.hash = base64(new Uint8Array(32));
    await publish(corrupt);
    await assert.rejects(
      colleague.templates.blob(reference.id, reference.version),
      "An authentic template signature cannot substitute bytes under a changed content hash",
    );
    await publish(original);
    await assertAssets(colleague, source, originals);

    const uploadedBefore = sent.filter(
      (request) => request.path === "zerotrust.fileChunks.put",
    ).length;
    await assert.rejects(
      business.templates.upload(
        new File(
          ["<svg><image href='https://outside.example/private.png'/></svg>"],
          "Externes-Bild.svg",
          { type: "image/svg+xml" },
        ),
      ),
    );
    assert.equal(
      sent.filter((request) => request.path === "zerotrust.fileChunks.put")
        .length,
      uploadedBefore,
    );

    const previous = await required(
      business.query("settings.documentTemplate.get", undefined),
    );
    discardMetadata = true;
    assert.ok(
      (
        await business.mutate("settings.documentTemplate.set", {
          source: source + "// verworfene Änderung",
          expectedRevision: previous.revision,
        })
      )[1],
    );
    discardMetadata = false;
    await assertAssets(colleague, source, originals);
    loseReply = true;
    source += "// nach verlorener Antwort gespeichert\n";
    const saved = await required(
      business.mutate("settings.documentTemplate.set", {
        source,
        expectedRevision: previous.revision,
      }),
    );
    assert.equal(loseReply, false);
    assert.equal(saved.source, source);
    await required(
      business.mutate("settings.documentTemplate.set", {
        source,
        expectedRevision: previous.revision,
      }),
    );
    const outcomes = await Promise.all([
      business.mutate("settings.documentTemplate.set", {
        source: source + "// A",
        expectedRevision: saved.revision,
      }),
      colleague.mutate("settings.documentTemplate.set", {
        source: source + "// B",
        expectedRevision: saved.revision,
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome[1] === null).length, 1);
    source = outcomes.find((outcome) => outcome[1] === null)![0]!.source!;
    await assertAssets(colleague, source, originals);
    console.log(
      "Native templates: exact PDF/image bytes, substituted hashes, external SVG rejection, false and lost replies, retries and concurrent source changes verified",
    );

    const person = await required(
      business.mutate("users.create", {
        username: "print.reader",
        firstName: "Druckvorlagen",
        lastName: "Leser",
        email: null,
        phone: null,
        costPerHour: 0,
        vacationDaysPerYear: 28,
        contractType: "internal",
        supervisorUserId: null,
      }),
    );
    const ownerAccount = unlockedAccount()!;
    colleague.dispose();
    const invitation = await createMemberInvitation(
      owner,
      {
        id: person.id,
        username: "print.reader",
      },
      {
        catalogue: "none",
        customers: "none",
        contacts: "none",
        vendors: "none",
        prices: "none",
        assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(
      peer,
      invitation.link,
      "Private-print-reader-password-2026!",
      signal,
    );
    const readerAccount = unlockedAccount()!;
    await unlock(ownerAccount);
    const lease = acquireDataRuntime(owner, signal, duckDriver);
    try {
      await approveMemberInvitation(
        owner,
        invitation.link.invitation.id,
        signal,
      );
    } finally {
      lease.close();
    }
    await unlock(readerAccount);
    colleague = createBusinessClient(peer, { productDriver: duckDriver });
    const session = await required(peer.query("auth.sessionInfo", undefined));
    assert.deepEqual(session.roles, []);
    assert.ok(
      (
        await peer.query(
          "zerotrust.keys.get",
          {
            domain: "organization:billing",
            generation: "1",
          },
          { strategy: "network-only" },
        )
      )[1],
    );
    await assertAssets(colleague, source, originals);
    const readerTemplate = await required(
      colleague.query("settings.documentTemplate.get", undefined),
    );
    assert.ok(
      (
        await colleague.mutate("settings.documentTemplate.set", {
          source: source + "// unerlaubt",
          expectedRevision: readerTemplate.revision,
        })
      )[1],
    );
    await assert.rejects(
      colleague.templates.upload(
        new File([originals.get("Musterlogo-48931.png")!], "Unerlaubt.png", {
          type: "image/png",
        }),
      ),
    );
    assert.ok(
      (
        await colleague.mutate("settings.documentTemplate.assets.delete", {
          id: asset.id,
        })
      )[1],
    );
    await unlock(ownerAccount);
    await changeAreaActionAccesses(
      owner,
      `user:${person.id}`,
      [{ area: PRINT_COLLECTION, patch: { read: false } }],
      signal,
    );
    await unlock(readerAccount);
    assert.ok(
      (await colleague.query("settings.documentTemplate.get", undefined))[1],
    );
    await assert.rejects(
      colleague.templates.blob(reference.id, reference.version),
    );
    assert.ok(
      (
        await peer.query(
          "zerotrust.keys.get",
          { domain: PRINT_COLLECTION.domain, generation: "1" },
          { strategy: "network-only" },
        )
      )[1],
    );
    await unlock(ownerAccount);
    await assertAssets(business, source, originals);
    console.log(
      "Native templates: ordinary reader can use assets without billing keys, cannot alter code/assets, and loses both metadata and byte access after revocation",
    );

    business.dispose();
    colleague.dispose();
    let phrase = draft.phrase;
    for (const round of [1, 2]) {
      const password = `Recovered-print-owner-${round}-2026!`;
      const recovery = await recoveryDraft(
        owner,
        draft.link.tenant,
        phrase,
        password,
        { restoreAdministrator: true },
      );
      const plan = await recoveryPlan(owner, recovery);
      await commitRecovery(owner, plan);
      await assert.rejects(
        recoveryDraft(owner, draft.link.tenant, phrase, password),
      );
      await signIn(owner, {
        tenant: draft.link.tenant,
        username: plan.username,
        password,
      });
      business = createBusinessClient(observed, { productDriver: duckDriver });
      await assertAssets(business, source, originals);
      business.dispose();
      phrase = recovery.newPhrase;
    }
    const wire = JSON.stringify(sent);
    for (const privateText of [
      "Vertraulicher Typst-Musterkopf 48931",
      "Musterlogo-48931.png",
      "Musterbriefpapier-48931.pdf",
      "nach verlorener Antwort gespeichert",
    ]) {
      assert.equal(
        wire.includes(privateText),
        false,
        "Template contents and asset names must stay encrypted on the wire",
      );
    }
    assert.equal(
      sent.some((request) => request.path.startsWith("settings.")),
      false,
    );
    console.log(
      "Native templates: two successive phrase-only recoveries retain exact source/PDF/image bytes; old phrases rejected and no plaintext template/upload calls observed",
    );
    return phrase;
  } finally {
    discardMetadata = false;
    loseReply = false;
    business.dispose();
    colleague.dispose();
    controller.abort();
  }
}
