import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createClient, type QueryInput } from "@sortsys/v2-client";
import { signPolicy } from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openChatDocuments } from "../app/lib/data/chatDocuments";
import { createProtectedProjectFiles } from "../app/lib/data/projectFiles";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import {
  fileCollection,
  fileObject,
  filePayload,
} from "../app/lib/data/projectFileData";
import { projectCollection } from "../app/lib/data/projectData";
import { publicId } from "../app/lib/data/products";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { administratorPolicyContext } from "../app/lib/crypto/administration";
import { changeProjectAccess } from "../app/lib/crypto/permissions";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const originalFetch = globalThis.fetch;
const requests: string[] = [];
// Clients capture fetch when constructed. Observe both GET and POST inputs.
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const input = args[0] instanceof Request ? args[0].url : String(args[0]);
    const url = new URL(input);
    for (const value of url.searchParams.values()) requests.push(value);
    if (typeof args[1]?.body === "string") requests.push(args[1].body);
    return Reflect.apply(target, receiver, args);
  },
});
const owner = createClient(endpoints[0], "document-search-owner");
const member = createClient(endpoints[1], "document-search-member");
const signal = new AbortController().signal;
const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT;
assert.equal(tenant, "document-search-tenant");
const login = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};
const query = "Fenster Wand";
const searchInput = { query, limit: 50n };
const secret = "VERTRAULICHER_SUCHINHALT_519842";
const readerPassword = "Document-search-member-password-519842!";
const visibleTitle = "Freigegebene Suchbaustelle 519842";
let ownerBusiness: ReturnType<typeof createBusinessClient> | undefined;
let memberBusiness: ReturnType<typeof createBusinessClient> | undefined;

function findDocuments(client: ReturnType<typeof createBusinessClient>, query: string) {
  return required(client.query("projects.files.search", { query, limit: 50n }));
}

function approvalEmail(text: string): Blob {
  const message = [
    "From: Bauleitung <bauleitung@example.test>",
    "Subject: Materialfreigabe der Bauleitung",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  return new Blob([message], { type: "message/rfc822" });
}

try {
  await signIn(owner, login);
  await initializeTenant(owner, signal, duckDriver);
  ownerBusiness = createBusinessClient(owner, { productDriver: duckDriver });
  const person = await required(
    ownerBusiness.mutate("users.create", {
      username: "document.reader",
      firstName: "Dokument",
      lastName: "Leser",
    }),
  );
  const invitation = await createMemberInvitation(
    owner,
    { id: person.id, username: "document.reader" },
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
    member,
    invitation.link,
    readerPassword,
    signal,
  );
  await joinMemberInvitation(member, invitation.link, signal);
  await signIn(owner, login);
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(member, {
    tenant: login.tenant,
    username: "document.reader",
    password: readerPassword,
  });
  const reader = unlockedAccount()!;
  await signIn(owner, login);
  const administrator = unlockedAccount()!;
  // A sign-in changed the owner's data lifetime; use its current facade.
  ownerBusiness.dispose();
  ownerBusiness = createBusinessClient(owner, { productDriver: duckDriver });
  const visible = await required(
    ownerBusiness.mutate("projects.create", {
      title: visibleTitle,
    }),
  );
  const hidden = await required(
    ownerBusiness.mutate("projects.create", {
      title: "Vertrauliche Kalkulation 519842",
    }),
  );
  async function upload(projectId: string, name: string, text: string) {
    return ownerBusiness!.files.upload({
      projectId,
      name,
      mime: "text/plain",
      blob: new Blob([text]),
      inspect: async () => ({ text }),
    });
  }
  const dense = await upload(
    visible.id,
    "Ausführung.txt",
    "Vorbemerkung. ".repeat(100) +
      "Fenster neben den Wänden einbauen. " +
      secret,
  );
  const sparse = await upload(
    visible.id,
    "Anlage.txt",
    "Fenster " + "Bauabschnitt ".repeat(100) + "Wände",
  );
  const forbidden = await upload(
    hidden.id,
    "Vertrauliche Preise.txt",
    "Fenster Wände " + secret,
  );

  async function addPagedDocuments(
    projectId: string,
    templateId: string,
    firstId: number,
  ) {
    const collection = await protectedCollection(
      owner,
      fileCollection(projectId),
      signal,
    );
    try {
      const templateObject = fileObject(projectId, templateId);
      const source = (await collection.read()).find(
        ({ envelope }) => envelope.object === templateObject,
      );
      assert.ok(source);
      const template = filePayload(source.value, templateObject, projectId);
      assert.ok(template.file);
      const file = template.file;
      const fileCount = 36;
      const lastId = String(firstId + fileCount - 1);
      const packets = await Promise.all(
        Array.from({ length: fileCount }, (_, index) => {
          const rowId = String(firstId + index);
          const id = publicId(rowId);
          return collection.packet(fileObject(projectId, id), {
            ...template,
            file: {
              ...file,
              values: {
                ...file.values,
                id: rowId,
                file_name: `Teilblatt ${index + 1}.txt`,
                size_bytes: "0",
                object_key: `encrypted:${id}`,
                extracted_text:
                  rowId === lastId ? "Pfostenanker" : "Kontrollpunkt",
              },
            },
            // The search should read the metadata without fetching a file.
            original: { version: "legacy", size: 0, parts: [] },
          });
        }),
      );
      await collection.write(packets);
      return publicId(lastId);
    } finally {
      collection.close();
    }
  }

  const pagedResults = [
    await addPagedDocuments(visible.id, dense, 100),
    await addPagedDocuments(hidden.id, forbidden, 200),
  ];
  const beforePagedSearch = requests.length;
  const pagedMatches = await findDocuments(ownerBusiness, "Pfostenanker");
  assert.deepEqual(
    new Set(pagedMatches.map(({ id }) => id)),
    new Set(pagedResults),
  );
  const fileDomains = [visible.id, hidden.id].map(
    (id) => fileCollection(id).domain,
  );
  type CapturedOperation = { json?: Partial<QueryInput<"zerotrust.objects.pages">> };
  const batchRequests = requests.slice(beforePagedSearch).flatMap((request) => {
    if (!request.includes('"selections":')) return [];
    const operations: Record<string, CapturedOperation> = JSON.parse(request);
    return Object.values(operations).flatMap(({ json }) =>
      json?.selections ? [json.selections] : [],
    );
  });
  assert.ok(
    batchRequests.some((selections) =>
      fileDomains.every((domain) =>
        selections.some((page) =>
          page.domain === domain && page.after !== null && page.snapshot !== null,
        ),
      ),
    ),
    "Two project continuations share one objects.pages operation",
  );

  const beforeWarmSearch = requests.length;
  assert.equal((await findDocuments(ownerBusiness, query)).length, 3);
  type SnapshotQuery = QueryInput<"zerotrust.access.snapshot">;
  const conditionalReads = requests.slice(beforeWarmSearch).flatMap((request) => {
    if (!request.includes('"pages":{"selections":')) return [];
    const operations: Record<string, { json?: SnapshotQuery }> =
      JSON.parse(request);
    return Object.values(operations).flatMap(({ json }) =>
      json?.known && json.pages ? [json.pages.selections] : [],
    );
  });
  assert.equal(conditionalReads.length, 2);
  const [load, verify] = conditionalReads;
  for (const domain of fileDomains) {
    assert.ok(load!.some((page) => page.domain === domain && page.known));
    assert.ok(
      verify!.some((page) => page.domain === domain && page.headOnly && page.snapshot),
    );
  }
  const beforeScopedSearch = requests.length;
  const scoped = await required(
    ownerBusiness.query("projects.files.search", {
      ...searchInput,
      projectId: visible.id,
    }),
  );
  assert.deepEqual(scoped.map(({ id }) => id), [dense, sparse]);
  const selectedAreas = JSON.stringify([
    fileCollection(visible.id).domain,
    projectCollection(visible.id).domain,
  ]);
  const combinedReads = requests.slice(beforeScopedSearch).filter(
    (request) =>
      request.includes(`"domains":${selectedAreas}`) &&
      request.includes('"pages":{"selections":'),
  );
  assert.equal(
    combinedReads.length,
    1,
    "The scoped search opens its first file page with the access check",
  );

  const staleText = "VERALTETE_TEXTERKENNUNG_519842";
  const staleVersion = await upload(visible.id, "Montagefassung.txt", staleText);
  const failedExtraction = await upload(
    visible.id,
    "Montageprotokoll.txt",
    staleText,
  );
  const attachments = await protectedCollection(
    owner,
    fileCollection(visible.id),
    signal,
  );
  try {
    const records = new Map(
      (await attachments.read()).map((entry) => [entry.envelope.object, entry]),
    );
    const packets = [];
    // Both combinations occur in old backups: retained text from an earlier
    // file version and retained text after a failed extraction.
    for (const [id, changes] of [
      [staleVersion, { office_version: "2" }],
      [failedExtraction, { text_extraction_status: "failed" }],
    ] as const) {
      const object = fileObject(visible.id, id);
      const previous = records.get(object)!;
      const payload = filePayload(previous.value, object, visible.id);
      assert.ok(payload.file);
      packets.push(
        await attachments.packet(
          object,
          {
            ...payload,
            file: {
              ...payload.file,
              values: { ...payload.file.values, ...changes },
            },
          },
          previous.envelope,
        ),
      );
    }
    await attachments.write(packets);
  } finally {
    attachments.close();
  }
  assert.deepEqual(
    await required(ownerBusiness.query("projects.files.search", {
      ...searchInput,
      query: staleText,
    })),
    [],
  );
  const byName = await required(ownerBusiness.query("projects.files.search", {
    ...searchInput,
    query: "Montage",
  }));
  assert.deepEqual(
    new Set(byName.map((result) => result.id)),
    new Set([staleVersion, failedExtraction]),
  );
  assert.ok(byName.every((result) => result.excerpt === null));

  const oldVersionText = "Altfassung Innenputzfreigabe";
  const newVersionText = "Neufassung Innenputzfreigabe";
  const versioned = await ownerBusiness.files.upload({
    projectId: visible.id,
    name: "Prüfprotokoll.eml",
    mime: "message/rfc822",
    blob: approvalEmail(oldVersionText),
  });
  const originalMatches = await findDocuments(ownerBusiness, `"${oldVersionText}"`);
  assert.deepEqual(originalMatches.map(({ id }) => id), [versioned]);
  const saved = await ownerBusiness.files.save(
    visible.id,
    versioned,
    1n,
    approvalEmail(newVersionText),
  );
  assert.equal(saved.version, 2n);

  const changing = await upload(visible.id, "Zwischenstand.txt", "Eichentür");
  let projectLookups = 0;
  let deletedDuringSearch = false;
  let validationStarts = 0;
  let validationCloses = 0;
  const racingSearch = createProtectedProjectFiles(
    owner,
    signal,
    async (ids) => {
      projectLookups++;
      assert.deepEqual(ids, [visible.id]);
      const project = await required(
        ownerBusiness!.query("projects.get", { id: visible.id }),
      );
      await required(
        ownerBusiness!.mutate("projects.files.delete", {
          projectId: visible.id,
          fileId: changing,
        }),
      );
      deletedDuringSearch = true;
      return [project];
    },
    async () => {
      validationStarts++;
      const { connection, close } = await duckDriver();
      return {
        connection,
        async close() {
          validationCloses++;
          await close();
        },
      };
    },
  );
  try {
    assert.deepEqual(
      await racingSearch.query("projects.files.search", { query: "Kupferdach" }),
      [],
    );
    assert.equal(projectLookups, 0);
    assert.deepEqual(
      await racingSearch.query("projects.files.search", { query: "Eichentür" }),
      [],
    );
    assert.equal(projectLookups, 1, "Only matched projects get a title lookup");
    assert.equal(deletedDuringSearch, true);
    assert.equal(
      validationStarts,
      1,
      "Changed snapshots reuse the validation database",
    );
  } finally {
    const closing = racingSearch.close();
    assert.equal(racingSearch.close(), closing);
    await closing;
  }
  assert.equal(validationCloses, 1, "Closing the adapter also closes its database");

  await acceptVaultWithKey(reader.dataKey, reader.vault, reader.username, false);
  memberBusiness = createBusinessClient(member, { productDriver: duckDriver });
  assert.deepEqual(
    await required(memberBusiness.query("projects.files.search", searchInput)),
    [],
  );
  assert.ok(
    (
      await memberBusiness.query("projects.files.search", {
        ...searchInput,
        projectId: visible.id,
      })
    )[1],
  );
  memberBusiness.dispose();
  await acceptVaultWithKey(administrator.dataKey, administrator.vault, administrator.username, false);
  await changeProjectAccess(
    owner,
    `user:${person.id}`,
    visible.id,
    "read",
    signal,
    "attachment",
  );
  await acceptVaultWithKey(reader.dataKey, reader.vault, reader.username, false);
  memberBusiness = createBusinessClient(member, { productDriver: duckDriver });
  const results = await required(
    memberBusiness.query("projects.files.search", searchInput),
  );
  assert.deepEqual(
    results.map((result) => result.id),
    [dense, sparse],
  );
  assert.equal(
    results.some((result) => result.id === forbidden),
    false,
  );
  assert.equal(
    results[0]!.projectTitle,
    "",
    "A file grant must not decrypt unrelated project master data",
  );
  const fileOnlyMatches = await required(
    memberBusiness.query("projects.files.search", {
      ...searchInput,
      projectId: visible.id,
    }),
  );
  assert.deepEqual(fileOnlyMatches, results);
  assert.match(results[0]!.excerpt!.text, /Fenster neben den Wänden/);
  assert.ok(results[0]!.excerpt!.text.startsWith("… "));
  const revisedMatches = await findDocuments(memberBusiness, `"${newVersionText}"`);
  assert.deepEqual(revisedMatches.map(({ id }) => id), [versioned]);
  assert.ok(revisedMatches[0]?.excerpt?.text.includes(newVersionText));
  assert.deepEqual(await findDocuments(memberBusiness, `"${oldVersionText}"`), []);
  const excluded = await required(
    memberBusiness.query("projects.files.search", {
      query: 'Wand -"Fenster neben"',
      limit: 50n,
    }),
  );
  assert.deepEqual(
    excluded.map((result) => result.id),
    [sparse],
  );
  const scopedFiles = createProtectedProjectFiles(member, signal, async () => {
    throw new Error("A file-only reader must not request project master data");
  }, duckDriver);
  try {
    const tools = await openChatDocuments(member, scopedFiles.searchScoped, signal);
    assert.ok(tools);
    const first = await tools.search({ query, limit: 1 }, signal);
    assert.deepEqual(first.documents.map(({ id }) => id), [dense]);
    assert.equal(first.nextOffset, 1);
    const next = await tools.search({ query, limit: 1, offset: 1 }, signal);
    assert.deepEqual(next.documents.map(({ id }) => id), [sparse]);
    assert.equal(next.nextOffset, null);
    await assert.rejects(() => tools.search({ query, projectId: hidden.id }, signal));
    await assert.rejects(() => tools.read({ projectId: hidden.id, fileId: forbidden }, signal));

    const args = { projectId: visible.id, fileId: dense };
    const page = await tools.read({ ...args, limit: 4 }, signal);
    assert.ok("text" in page);
    assert.equal(page.text, "Vorb");
    assert.equal(page.nextOffset, 4);
    await assert.rejects(() => tools.read({ ...args, offset: 4 }, signal));
    const stale = await tools.read({ projectId: visible.id, fileId: staleVersion }, signal);
    assert.ok("revision" in stale);
    assert.equal(stale.contentAvailable, false);
    assert.equal(stale.text, null);
    assert.equal(stale.unavailableReason, "stale_or_missing_extraction");
    assert.deepEqual(
      await tools.read({ ...args, revision: stale.revision, offset: 4 }, signal),
      { contentAvailable: false, unavailableReason: "document_changed" },
    );
  } finally {
    await scopedFiles.close();
  }

  memberBusiness.dispose();
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const invalidEmail = new Uint8Array([0xff]);
  const failedSave = await ownerBusiness.files.save(
    visible.id,
    versioned,
    2n,
    new Blob([invalidEmail], { type: "message/rfc822" }),
  );
  assert.equal(failedSave.version, 3n);
  const file = await ownerBusiness.files.blob(visible.id, versioned);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), invalidEmail);
  assert.deepEqual(await findDocuments(ownerBusiness, `"${newVersionText}"`), []);
  const filenameMatches = await findDocuments(ownerBusiness, "Prüfprotokoll");
  assert.deepEqual(filenameMatches.map(({ id }) => id), [versioned]);
  assert.equal(filenameMatches[0]?.excerpt, null);
  await changeProjectAccess(
    owner,
    `user:${person.id}`,
    visible.id,
    "read",
    signal,
  );
  const context = await administratorPolicyContext(owner, signal);
  const nextVersion = BigInt(context.permissions.version) + 1n;
  const withoutTitle = {
    ...context.permissions,
    version: nextVersion.toString(),
    rules: context.permissions.rules.filter(
      (rule) =>
        rule.subject !== `user:${person.id}` ||
        rule.scope !== projectCollection(visible.id).scope ||
        rule.facet !== "master-data",
    ),
  };
  const titleRevocation = await signPolicy(withoutTitle, context.authority);
  const fileRevocation = await signPolicy(
    {
      ...withoutTitle,
      version: (nextVersion + 1n).toString(),
      rules: withoutTitle.rules.filter(
        (rule) =>
          rule.subject !== `user:${person.id}` ||
          rule.scope !== fileCollection(visible.id).scope ||
          rule.facet !== "attachment",
      ),
    },
    context.authority,
  );
  // Keep the reader's account and search cache open. Only the other API
  // applies the signed revocation after the reader has loaded the title.
  await acceptVaultWithKey(reader.dataKey, reader.vault, reader.username, false);
  memberBusiness = createBusinessClient(member, { productDriver: duckDriver });
  let revokedDuringSearch = false;
  const titleRace = createProtectedProjectFiles(
    member,
    signal,
    async (ids) => {
      assert.deepEqual(ids, [visible.id]);
      const project = await required(
        memberBusiness!.query("projects.get", { id: visible.id }),
      );
      assert.equal(project.title, visibleTitle);
      await required(owner.mutate("zerotrust.policy.replace", titleRevocation));
      revokedDuringSearch = true;
      return [project];
    },
    duckDriver,
  );
  const openTools = await openChatDocuments(member, titleRace.searchScoped, signal);
  assert.ok(openTools);
  try {
    const found = (await titleRace.query("projects.files.search", searchInput)) as {
      id: string;
      projectTitle: string;
    }[];
    assert.equal(revokedDuringSearch, true);
    assert.deepEqual(
      found.map(({ id, projectTitle }) => [id, projectTitle]),
      [[dense, ""], [sparse, ""]],
    );
  } finally {
    await titleRace.close();
  }
  const beforeRevocation = await required(
    member.query("zerotrust.access.snapshot", {}, { strategy: "network-only" }),
  );
  const area = fileCollection(visible.id);
  const readGuard: SnapshotQuery = {
    known: beforeRevocation.snapshot,
    pages: {
      selections: [{
        domain: area.domain,
        prefix: area.prefix,
        after: null,
        snapshot: null,
        headOnly: true,
      }],
    },
  };
  const currentGuard = await required(
    member.query("zerotrust.access.snapshot", readGuard, {
      strategy: "network-only",
    }),
  );
  assert.equal(currentGuard.unchanged, true);
  assert.equal(currentGuard.pages?.length, 1);
  await required(owner.mutate("zerotrust.policy.replace", fileRevocation));
  const staleGuard = await required(
    member.query("zerotrust.access.snapshot", readGuard, {
      strategy: "network-only",
    }),
  );
  assert.equal(staleGuard.unchanged, false);
  assert.equal(staleGuard.pages, undefined);
  const [denied, deniedError] = await member.query(
    "zerotrust.access.snapshot",
    { ...readGuard, known: staleGuard.snapshot },
    { strategy: "network-only" },
  );
  assert.equal(denied, null);
  assert.equal(deniedError?.code, "FORBIDDEN");
  await assert.rejects(() => openTools.read({ projectId: visible.id, fileId: dense }, signal));
  assert.equal(await openChatDocuments(member, titleRace.searchScoped, signal), null);
  const emptyFiles = createProtectedProjectFiles(
    member,
    signal,
    async () => {
      throw new Error(
        "Refreshing an empty file inventory must not read project master data",
      );
    },
    duckDriver,
  );
  try {
    await emptyFiles.refresh();
  } finally {
    await emptyFiles.close();
  }
  assert.deepEqual(
    await required(memberBusiness.query("projects.files.search", searchInput)),
    [],
  );
  assert.ok(
    (
      await memberBusiness.query("projects.files.search", {
        ...searchInput,
        projectId: visible.id,
      })
    )[1],
  );
  const wire = requests.join("\n");
  assert.ok(
    wire.includes("sortsys-hpke-v1"),
    "The leak check must observe encrypted RPC payloads",
  );
  for (const privateText of [
    query,
    secret,
    "Pfostenanker",
    oldVersionText,
    newVersionText,
    "Vertrauliche Preise.txt",
    visibleTitle,
  ]) {
    assert.equal(
      wire.includes(privateText),
      false,
      "Search terms, document contents and file names must stay client-side",
    );
  }
  console.log(
    "Native document search verified across two APIs: local ranking and excerpts, deleted files and revoked titles during search, and attachment revocation with an already populated client cache.",
  );
  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    await acceptVaultWithKey(
      administrator.dataKey,
      administrator.vault,
      administrator.username,
      false,
    );
    ownerBusiness.dispose();
    ownerBusiness = createBusinessClient(owner, { productDriver: duckDriver });
    await changeProjectAccess(
      owner,
      `user:${person.id}`,
      visible.id,
      "read",
      signal,
      "attachment",
    );
    const fileName = "Freigegebener Plan 519842.pdf";
    const pdf = await readFile(
      new URL("../../sortsys-api-v2/seed-assets/materialfreigabe.pdf", import.meta.url),
    );
    const fileId = await ownerBusiness.files.upload({
      projectId: visible.id,
      name: fileName,
      mime: "application/pdf",
      blob: new Blob([pdf], { type: "application/pdf" }),
      inspect: async () => ({
        text:
          "Rückbau und Asbest im Bestand. " +
          "Allgemeine Hinweise zur Baustelle. ".repeat(22) +
          "Suchfenster",
      }),
    });
    const fixture = process.argv[4]!;
    await writeFile(fixture, JSON.stringify({
      success: true,
      tenant,
      projectId: visible.id,
      projectTitle: visibleTitle,
      fileId,
      fileName,
      pagedFileId: pagedResults[0],
      deniedProjectId: hidden.id,
      deniedFileId: forbidden,
    }));
    await new Promise<void>((resolve, reject) => {
      const child = spawn("node", ["scripts/e2e/documentAccess.browser.mjs", fixture], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, SORTSYS_E2E_READER_PASSWORD: readerPassword },
      });
      child.once("message", (message) => {
        const revoke = async () => {
          assert.equal(message, "revoke-document-search");
          await changeProjectAccess(
            owner,
            `user:${person.id}`,
            visible.id,
            "none",
            signal,
            "attachment",
          );
          child.send("document-search-revoked");
        };
        void revoke().catch((error) => {
          child.kill();
          reject(error);
        });
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Document access browser test failed: ${signal ?? code}`));
      });
    });
  }
} finally {
  globalThis.fetch = originalFetch;
  memberBusiness?.dispose();
  ownerBusiness?.dispose();
  await lockCryptoSession();
  owner.setToken(null);
  member.setToken(null);
}
