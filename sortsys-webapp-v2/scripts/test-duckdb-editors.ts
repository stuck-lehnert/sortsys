import assert from "node:assert/strict";
import { createClient } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { required } from "../app/lib/data/protectedObjects";
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
    if (
      readChunksOnPeer &&
      targetUrl.pathname
        .slice(1)
        .split(",")
        .includes("zerotrust.fileChunks.get")
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
    drawioUrl: "/drawio",
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
  const diagram = await required(
    business.query("projects.files.drawioConfig", {
      projectId: project.id,
      fileId: diagramId,
    }),
  );
  assert.equal(diagram.editorUrl, expected.drawioUrl);
  assert.equal(diagram.xml, xml);
  const editedXml = xml.replace(
    "CONFIDENTIAL_DIAGRAM_846281",
    "CONFIDENTIAL_DIAGRAM_EDIT_846281",
  );
  await business.files.save(project.id, diagramId, 1n, new Blob([editedXml]));
  const saved = await required(
    business.query("projects.files.drawioConfig", {
      projectId: project.id,
      fileId: diagramId,
    }),
  );
  assert.equal(saved.xml, editedXml);
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
  const manifest = await storeFileContent(
    owner,
    projectId,
    file,
    blob,
    version,
    signal,
  );
  assert.equal(manifest.parts.length, 9);

  function readBatches(start: number) {
    return sent
      .slice(start)
      .map((request) => new URL(request.url).pathname.slice(1).split(","))
      .map((paths) =>
        paths.filter((path) => path === "zerotrust.fileChunks.get"),
      )
      .filter((paths) => paths.length > 0);
  }
  function checkReads(start: number) {
    const batches = readBatches(start);
    assert.equal(batches[0]?.length, 4);
    assert.ok(batches.every((paths) => paths.length <= 4));
    assert.equal(batches.flat().length, 9);
    assert.ok(batches.length < 9);
    return batches.map((paths) => paths.length);
  }
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
    assert.ok(
      sent
        .slice(resumeStart)
        .every(
          (request) =>
            !new URL(request.url).pathname
              .split(",")
              .some((path) => path.endsWith("zerotrust.fileChunks.put")),
        ),
    );
    console.log(
      `Native file batches: 9 blocks; load HTTP groups ${loadBatches.join(", ")}; verification HTTP groups ${verifyBatches.join(", ")}; resumed without writes; readback through independent API`,
    );
  } finally {
    readChunksOnPeer = false;
  }
  const domain = chunkCollection(projectId).domain;
  const denied = await Promise.all(
    manifest.parts
      .slice(0, 4)
      .map((part) =>
        member.query(
          "zerotrust.fileChunks.get",
          { domain, id: part.id },
          { strategy: "network-only" },
        ),
      ),
  );
  assert.ok(denied.every(([, error]) => error?.data?.httpCode === 403));
  const mixed = await Promise.all([
    owner.query(
      "zerotrust.fileChunks.get",
      { domain, id: manifest.parts[0]!.id },
      { strategy: "network-only" },
    ),
    owner.query(
      "zerotrust.fileChunks.get",
      { domain, id: "file-data:999:3:cccccccccccccccccccccccccccccccc:0" },
      { strategy: "network-only" },
    ),
  ]);
  assert.equal(mixed[0]![0]?.object, manifest.parts[0]!.id);
  assert.equal(mixed[1]![1]?.data?.httpCode, 403);
}
