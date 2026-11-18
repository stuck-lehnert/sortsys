import assert from "node:assert/strict";
import superjson from "superjson";
import { createClient, RpcClientError } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import {
  base64,
  digest,
  encryptedObject,
  objectFrame,
  signedPacketFrame,
} from "@sortsys/zerotrust/sortsys";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { changeProjectAccess } from "../app/lib/crypto/permissions";
import {
  commitOwner,
  prepareOwner,
  tenantSetupRequest,
} from "../app/lib/crypto/tenantSetup";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { testFilePermissions } from "./test-live-file-permissions";
import {
  loadFileContent,
  storeFileContent,
  verifyFileContent,
} from "../app/lib/data/fileContent";
import {
  chunkCollection,
  contentId,
  FILE_CHUNK_BYTES,
} from "../app/lib/data/projectFileData";

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
const sent: { url: string; body: string }[] = [];
let readChunksOnPeer = false;
let dropChunkWriteReply = false;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = new Proxy(fetchOriginal, {
  apply(target, receiver, args) {
    const [input, options] = args;
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    sent.push({
      url,
      body: typeof options?.body === "string" ? options.body : "",
    });
    const targetUrl = new URL(url);
    const paths = targetUrl.pathname.slice(1).split(",");
    if (dropChunkWriteReply && paths.includes("zerotrust.fileChunks.putMany")) {
      dropChunkWriteReply = false;
      return Reflect.apply(target, receiver, args).then(
        async (reply: Response) => {
          await reply.arrayBuffer();
          throw new TypeError("File chunk acknowledgement lost after commit");
        },
      );
    }
    if (
      readChunksOnPeer &&
      paths.some(
        (path) =>
          path === "zerotrust.fileChunks.getMany" ||
          path === "zerotrust.fileChunks.findMany",
      )
    ) {
      const peerUrl = new URL(
        targetUrl.pathname + targetUrl.search,
        endpoints[1],
      );
      return Reflect.apply(target, receiver, [peerUrl, options]);
    }
    return Reflect.apply(target, receiver, args);
  },
});
// Capture fetch only after installing the probe, so RPC traffic participates
// in both the wire assertions and the independent-instance readback.
const operator = createClient(endpoints[0], "native-editor-operator");
const owner = createClient(endpoints[0], "native-editor-owner");
const member = createClient(endpoints[1], "native-editor-member");
const controller = new AbortController();
const signal = controller.signal;
const business = createBusinessClient(owner, { productDriver: duckDriver });
try {
  const anonymous = await fetch(
    new URL("zerotrust.editors.config", endpoints[0]),
  );
  const rejection = await anonymous.json();
  assert.equal(rejection.error?.json?.data?.httpCode, 401);
  const login = await required(
    operator.mutate("admin.login", {
      tenant: null,
      password: "Native-editor-operator-password-2026!",
    }),
  );
  operator.setToken(login.token);
  const { request, link } = await tenantSetupRequest("editor-tenant");
  await required(operator.mutate("admin.tenants.create", request));
  const draft = await prepareOwner(
    owner,
    link,
    "builder",
    "Private-editor-owner-password-2026!",
  );
  await commitOwner(owner, draft);
  await initializeTenant(owner, signal, duckDriver);
  console.log("Native editors: tenant initialized");
  const account = unlockedAccount()!;
  const profile = await required(
    business.mutate("users.create", {
      username: "editor.member",
      firstName: "Dateifreigabe",
      lastName: "Mitarbeiter",
      email: null,
      phone: null,
      costPerHour: 67.5,
      vacationDaysPerYear: 28,
      contractType: "internal",
      supervisorUserId: null,
    }),
  );
  const invitation = await createMemberInvitation(
    owner,
    { id: profile.id, username: "editor.member" },
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
    "Private-editor-member-password-2026!",
    signal,
  );
  const colleague = unlockedAccount()!;
  await acceptVaultWithKey(
    account.dataKey,
    account.vault,
    account.username,
    false,
  );
  const lease = acquireDataRuntime(owner, signal, duckDriver);
  try {
    await approveMemberInvitation(owner, invitation.link.invitation.id, signal);
  } finally {
    lease.close();
  }
  console.log("Native editors: member enrolled");
  const expected = {
    officeOrigin: "http://127.0.0.1:29400",
  };
  assert.deepEqual(
    await required(owner.query("zerotrust.editors.config", undefined)),
    expected,
  );
  assert.deepEqual(
    await required(member.query("zerotrust.editors.config", undefined)),
    expected,
  );
  const project = await required(
    business.mutate("projects.create", {
      title: "Fenstersanierung mit privater Werkplanung",
    }),
  );
  await checkBatchedFileContent(project.id);
  const document = new Blob(["CONFIDENTIAL_OFFICE_NATIVE_846281"], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const fileId = await business.files.upload({
    projectId: project.id,
    name: "Private Planung.docx",
    mime: document.type,
    blob: document,
  });
  const opened = await business.files.office(project.id, fileId);
  assert.equal(opened.editorOrigin, expected.officeOrigin);
  assert.equal(await opened.document.text(), await document.text());
  assert.equal(opened.canEdit, true);

  const xml =
    '<mxfile><diagram id="private">CONFIDENTIAL_DIAGRAM_846281</diagram></mxfile>';
  const diagramId = await business.files.upload({
    projectId: project.id,
    name: "Werkplanung.drawio",
    mime: "application/vnd.jgraph.mxfile",
    blob: new Blob([xml]),
  });
  const diagram = await business.files.office(project.id, diagramId);
  assert.equal(diagram.editorOrigin, expected.officeOrigin);
  assert.equal(await diagram.document.text(), xml);
  assert.equal(diagram.canEdit, true);
  const editedXml = xml.replace(
    "CONFIDENTIAL_DIAGRAM_846281",
    "CONFIDENTIAL_DIAGRAM_EDIT_846281",
  );
  await business.files.save(project.id, diagramId, 1n, new Blob([editedXml]));
  const saved = await business.files.office(project.id, diagramId);
  assert.equal(await saved.document.text(), editedXml);
  await changeProjectAccess(
    owner,
    `user:${profile.id}`,
    project.id,
    "read",
    signal,
  );
  console.log(
    "Native editors: private Office/diagram files opened and diagram saved; checking file permissions",
  );
  await testFilePermissions(
    owner,
    member,
    account,
    colleague,
    duckDriver,
    signal,
    project.id,
  );
  const wire = JSON.stringify(sent);
  for (const privateText of [
    "CONFIDENTIAL_OFFICE_NATIVE_846281",
    "CONFIDENTIAL_DIAGRAM_846281",
    "CONFIDENTIAL_DIAGRAM_EDIT_846281",
    "Private Planung.docx",
    "Edited by a file-only collaborator",
    "After ordinary file-only edit",
    "Unconfirmed Office draft recovered after key rotation",
    "Stale losing Office handoff",
    "CONFIDENTIAL_BATCHED_FILE_846281",
    "CONFIDENTIAL_PREVIEW_UPLOAD_846281",
    "CONFIDENTIAL_PREVIEW_THUMBNAIL_846281",
    `/2/integration/edit/${"c".repeat(24)}/`,
    `/2/integration/view/${"c".repeat(32)}/`,
  ]) {
    assert.equal(
      wire.includes(privateText),
      false,
      `Private editor content escaped: ${privateText}`,
    );
  }
  console.log(
    "Native editors verified: production startup, authenticated public configuration, private Office/diagram opening, file-only editor grants, encrypted capabilities, concurrent room winner, revocation and rejected stale saves across independent APIs.",
  );
} finally {
  globalThis.fetch = fetchOriginal;
  controller.abort();
  business.dispose();
  lockCryptoSession();
  operator.setToken(null);
  owner.setToken(null);
  member.setToken(null);
}

async function checkBatchedFileContent(projectId: string) {
  const bytes = new Uint8Array(8 * FILE_CHUNK_BYTES + 31);
  for (let index = 0; index < 9; index++) {
    const offset = index * FILE_CHUNK_BYTES;
    bytes.fill(index + 1, offset, offset + FILE_CHUNK_BYTES);
  }
  bytes.set(new TextEncoder().encode("CONFIDENTIAL_BATCHED_FILE_846281"));
  const blob = new Blob([bytes]);
  const file = "3";
  const version = "c".repeat(32);
  const uploadStart = sent.length;
  const manifest = await storeFileContent(
    owner,
    projectId,
    file,
    blob,
    version,
    signal,
  );
  assert.equal(manifest.parts.length, 9);

  function chunkRequests<T>(start: number, procedure: string): T[] {
    return sent.slice(start).flatMap((request) => {
      const url = new URL(request.url);
      const paths = url.pathname.slice(1).split(",");
      const index = paths.indexOf(`zerotrust.fileChunks.${procedure}`);
      if (index < 0) return [];
      const encoded = JSON.parse(
        request.body || url.searchParams.get("input")!,
      );
      return [superjson.deserialize<T>(encoded[index])];
    });
  }
  function checkReads(start: number, procedure = "getMany") {
    const batches = chunkRequests<{ ids: string[] }>(start, procedure).map(
      (request) => request.ids.length,
    );
    assert.deepEqual(batches, [4, 4, 1]);
    return batches;
  }
  const uploadBatches = chunkRequests<{ envelopes: unknown[] }>(
    uploadStart,
    "putMany",
  ).map((request) => request.envelopes.length);
  assert.deepEqual(uploadBatches, [4, 4, 1]);
  assert.deepEqual(chunkRequests(uploadStart, "put"), []);
  assert.deepEqual(chunkRequests(uploadStart, "getMany"), []);
  readChunksOnPeer = true;
  try {
    const loadStart = sent.length;
    const loaded = await loadFileContent(
      owner,
      projectId,
      file,
      manifest,
      "application/octet-stream",
      signal,
    );
    assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), bytes);
    const loadBatches = checkReads(loadStart);
    const verifyStart = sent.length;
    await verifyFileContent(owner, projectId, file, manifest, blob, signal);
    const verifyBatches = checkReads(verifyStart);
    const resumeStart = sent.length;
    assert.deepEqual(
      await storeFileContent(owner, projectId, file, blob, version, signal, {
        resume: true,
      }),
      manifest,
    );
    const resumeBatches = checkReads(resumeStart, "findMany");
    assert.deepEqual(chunkRequests(resumeStart, "put"), []);
    assert.deepEqual(chunkRequests(resumeStart, "putMany"), []);
    console.log(
      `Native file batches: 9 blocks; writes ${uploadBatches.join(", ")} with hash receipts and no readback; load ${loadBatches.join(", ")}; verification ${verifyBatches.join(", ")}; resume ${resumeBatches.join(", ")} without writes; reads through independent API`,
    );
  } finally {
    readChunksOnPeer = false;
  }
  const image = new Blob(["CONFIDENTIAL_PREVIEW_UPLOAD_846281"]);
  const thumbnail = new Blob(["CONFIDENTIAL_PREVIEW_THUMBNAIL_846281"], {
    type: "image/webp",
  });
  const imageStart = sent.length;
  readChunksOnPeer = true;
  try {
    const imageId = await business.files.upload({
      projectId,
      name: "Fassadendetail.png",
      mime: "image/png",
      blob: image,
      inspect: async () => ({ thumbnail, width: 32, height: 32 }),
    });
    const writes = chunkRequests<{ envelopes: { object: string }[] }>(
      imageStart,
      "putMany",
    );
    assert.equal(writes.length, 1);
    const writtenIds = writes[0]!.envelopes.map(({ object }) => object);
    assert.equal(writtenIds.length, 2);
    assert.equal(new Set(writtenIds).size, 2);
    assert.deepEqual(chunkRequests(imageStart, "getMany"), []);
    const original = await business.files.blob(projectId, imageId);
    const preview = await business.files.blob(
      projectId,
      imageId,
      undefined,
      true,
    );
    assert.equal(await original.text(), await image.text());
    assert.equal(await preview.text(), await thumbnail.text());
    assert.equal(preview.type, thumbnail.type);
    console.log(
      "Native image upload: original and thumbnail share one request; both open across the second API",
    );
    const retryStart = sent.length;
    dropChunkWriteReply = true;
    const recovered = await storeFileContent(
      owner,
      projectId,
      file,
      image,
      "e".repeat(32),
      signal,
    );
    assert.equal(chunkRequests(retryStart, "putMany").length, 1);
    assert.deepEqual(chunkRequests(retryStart, "getMany"), [
      {
        domain: chunkCollection(projectId).domain,
        ids: recovered.parts.map((part) => part.id),
      },
    ]);
    console.log(
      "Native image upload: lost acknowledgement recovered by reading committed ciphertext from the second API",
    );
  } finally {
    dropChunkWriteReply = false;
    readChunksOnPeer = false;
  }
  const domain = chunkCollection(projectId).domain;
  const ids = manifest.parts.map((part) => part.id);
  const [denied, deniedError] = await member.query(
    "zerotrust.fileChunks.getMany",
    { domain, ids: ids.slice(0, 4) },
    { strategy: "network-only" },
  );
  assert.equal(denied, null);
  assert.equal(deniedError?.data?.httpCode, 403);
  const requested = [ids[3]!, ids[0]!, ids[8]!];
  const ordered = await required(
    owner.query(
      "zerotrust.fileChunks.getMany",
      { domain, ids: requested },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(
    ordered.map((packet) => packet.object),
    requested,
  );
  const [, foreignError] = await owner.query(
    "zerotrust.fileChunks.getMany",
    {
      domain,
      ids: [ids[0]!, "file-data:999:3:cccccccccccccccccccccccccccccccc:0"],
    },
    { strategy: "network-only" },
  );
  assert.equal(foreignError?.data?.httpCode, 403);
  for (const invalidIds of [[], ids.slice(0, 5), [ids[0]!, ids[0]!]]) {
    const [data, error] = await owner.query(
      "zerotrust.fileChunks.getMany",
      { domain, ids: invalidIds },
      { strategy: "network-only" },
    );
    assert.equal(data, null);
    assert.equal(error?.code, "BAD_REQUEST");
  }
  const missing = `${ids[0]!.slice(0, -1)}99`;
  const [partial, missingError] = await owner.query(
    "zerotrust.fileChunks.getMany",
    { domain, ids: [ids[0]!, missing] },
    { strategy: "network-only" },
  );
  assert.equal(partial, null);
  assert.equal(missingError?.data?.httpCode, 404);

  const lookup = await required(
    owner.query(
      "zerotrust.fileChunks.findMany",
      { domain, ids: [missing, ids[8]!, ids[0]!] },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(
    lookup.map((packet) => packet?.object ?? null),
    [null, ids[8]!, ids[0]!],
  );
  const [, lookupDenied] = await member.query(
    "zerotrust.fileChunks.findMany",
    { domain, ids: [missing, ids[0]!] },
    { strategy: "network-only" },
  );
  assert.equal(lookupDenied?.data?.httpCode, 403);

  const newId = contentId(projectId, file, "f".repeat(32), 0);
  const existingPacket = ordered[0]!;
  const collection = await protectedCollection(
    owner,
    chunkCollection(projectId),
    signal,
  );
  const differentBytes = {
    format: "sortsys-file-block-v1",
    data: base64(new Uint8Array([4, 5, 6])),
  };
  let newPacket;
  let conflictingPacket;
  try {
    newPacket = await collection.packet(newId, differentBytes, undefined, true);
    conflictingPacket = await collection.packet(
      existingPacket.object,
      differentBytes,
      undefined,
      true,
    );
  } finally {
    collection.close();
  }
  const forged = { ...existingPacket, signature: base64(new Uint8Array(64)) };
  const [badWrite, badWriteError] = await owner.mutate(
    "zerotrust.fileChunks.putMany",
    { domain, envelopes: [newPacket.envelope, forged] },
  );
  assert.equal(badWrite, null);
  assert.ok(badWriteError);
  const [, conflict] = await owner.mutate("zerotrust.fileChunks.putMany", {
    domain,
    envelopes: [newPacket.envelope, conflictingPacket.envelope],
  });
  assert.ok(conflict instanceof RpcClientError);
  assert.equal(conflict.code, "CONFLICT");
  const [, writeDenied] = await member.mutate("zerotrust.fileChunks.putMany", {
    domain,
    envelopes: [newPacket.envelope],
  });
  assert.ok(writeDenied instanceof RpcClientError);
  assert.equal(writeDenied.data?.httpCode, 403);
  for (const envelopes of [[], [newPacket.envelope, newPacket.envelope]]) {
    const [, invalidWrite] = await owner.mutate(
      "zerotrust.fileChunks.putMany",
      {
        domain,
        envelopes,
      },
    );
    assert.ok(invalidWrite instanceof RpcClientError);
    assert.equal(invalidWrite.code, "BAD_REQUEST");
  }
  const [unpublished] = await required(
    owner.query(
      "zerotrust.fileChunks.findMany",
      { domain, ids: [newId] },
      { strategy: "network-only" },
    ),
  );
  assert.equal(unpublished, null);
  const packets = [newPacket.envelope, existingPacket];
  const expectedHashes = await Promise.all(
    packets.map((input) => {
      const packet = encryptedObject(input);
      return digest(signedPacketFrame(objectFrame(packet), packet.signature));
    }),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await required(
      owner.mutate("zerotrust.fileChunks.putMany", {
        domain,
        envelopes: packets,
      }),
    );
    assert.equal(receipt.success, true);
    assert.deepEqual(receipt.hashes, expectedHashes);
  }
  readChunksOnPeer = true;
  try {
    const stored = await required(
      owner.query(
        "zerotrust.fileChunks.getMany",
        { domain, ids: packets.map((packet) => packet.object) },
        { strategy: "network-only" },
      ),
    );
    assert.deepEqual(stored, packets);
  } finally {
    readChunksOnPeer = false;
  }
}
