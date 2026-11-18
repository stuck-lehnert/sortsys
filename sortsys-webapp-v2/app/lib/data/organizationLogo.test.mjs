import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import {
  logoImage,
  logoPayload,
  LOGO_COLLECTION,
  LOGO_OBJECT,
  logoResource,
  readLogoResource,
} from "./logoData";
import { storeFileContent, verifyFileContent } from "./fileContent";
import { legacyLogo } from "./migrateLogo";
import { createProtectedLogo } from "./organizationLogo";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
);
const empty = {
  format: "sortsys-organization-logo-v1",
  image: null,
  issue: null,
};
const file = () =>
  new File([png], "Internes Logo 479152.png", { type: "image/png" });
async function prepare() {
  return {
    blob: new Blob([png], { type: "image/png" }),
    fileName: file().name,
    width: 1,
    height: 1,
  };
}
async function fixture(actions, existing = true, processor = prepare) {
  const tenant = await protectedTenant([LOGO_COLLECTION], actions);
  if (existing) await tenant.seed(LOGO_COLLECTION, LOGO_OBJECT, empty);
  const controller = new AbortController();
  const store = createProtectedLogo(
    tenant.client,
    controller.signal,
    duckDriver,
    processor,
  );
  return {
    ...tenant,
    controller,
    store,
    close: () => {
      controller.abort();
      store.close();
    },
  };
}
afterEach(() => lockCryptoSession());

// These checks use real area keys and signatures. The fixture's in-memory CAS
// models conflicting writes; it does not establish native server enforcement.
test("logo upload encrypts metadata and bytes and verifies a lost acknowledgement", async () => {
  const tenant = await fixture();
  try {
    tenant.state.loseReply = true;
    tenant.state.loseChunkReply = true;
    expect(await tenant.store.upload(file())).toEqual({ success: true });
    const saved = (await tenant.plain(LOGO_COLLECTION, LOGO_OBJECT)).image;
    expect(saved.fileName).toBe(file().name);
    const status = await tenant.store.query(undefined);
    expect(status.downloadUrl).toBe(logoResource(saved));
    const blob = await tenant.store.blob(saved.id, saved.content.version);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect(JSON.stringify(tenant.calls)).not.toContain(file().name);
    expect(JSON.stringify(tenant.calls)).not.toContain(
      Uint8Array.prototype.toBase64.call(png),
    );
    expect(
      tenant.calls.some((call) => call.path.startsWith("settings.tenantLogo.")),
    ).toBe(false);
    expect(tenant.objects.size).toBe(1);
    expect(tenant.chunks.size).toBe(1);
  } finally {
    tenant.close();
  }
});

test("a false block acknowledgement never replaces the previous logo", async () => {
  const tenant = await fixture();
  try {
    const signature = tenant.objects.get(LOGO_OBJECT).signature;
    tenant.state.discardChunk = true;
    await expect(tenant.store.upload(file())).rejects.toThrow();
    expect(tenant.objects.get(LOGO_OBJECT).signature).toBe(signature);
    expect(
      tenant.calls.some((call) => call.path === "zerotrust.objects.batch"),
    ).toBe(false);
    tenant.state.discardChunk = false;
    await tenant.store.upload(file());
    expect((await tenant.store.query()).status).toBe("ready");
  } finally {
    tenant.close();
  }
});

test("a false metadata acknowledgement cannot report a successful upload", async () => {
  const tenant = await fixture();
  try {
    tenant.state.discardCommit = true;
    await expect(tenant.store.upload(file())).rejects.toThrow();
    expect((await tenant.plain(LOGO_COLLECTION, LOGO_OBJECT)).image).toBeNull();
  } finally {
    tenant.close();
  }
});

test("replacement requires update permission; first creation requires create permission", async () => {
  for (const [actions, existing, allowed] of [
    [["read"], true, false],
    [["read", "update"], true, true],
    [["read", "create"], true, false],
    [["read", "create"], false, true],
    [["read", "update"], false, false],
  ]) {
    const tenant = await fixture(() => actions, existing);
    try {
      if (allowed) await tenant.store.upload(file());
      else {
        await expect(tenant.store.upload(file())).rejects.toThrow();
        expect(tenant.chunks.size).toBe(0);
      }
    } finally {
      tenant.close();
    }
  }
});

test("a concurrent replacement is not overwritten by an upload prepared earlier", async () => {
  let tenant;
  tenant = await fixture(undefined, true, async () => {
    await tenant.seed(LOGO_COLLECTION, LOGO_OBJECT, {
      ...empty,
      issue: "legacy-incomplete",
    });
    return prepare();
  });
  try {
    await expect(tenant.store.upload(file())).rejects.toThrow();
    expect(await tenant.plain(LOGO_COLLECTION, LOGO_OBJECT)).toEqual({
      ...empty,
      issue: "legacy-incomplete",
    });
  } finally {
    tenant.close();
  }
});

test("cancelled conversion and cancelled staging do not publish a manifest", async () => {
  for (const stage of ["decode", "staging"]) {
    const cancellation = new AbortController();
    const processor = async () => {
      if (stage === "decode") cancellation.abort();
      return prepare();
    };
    const tenant = await fixture(undefined, true, processor);
    if (stage === "staging")
      tenant.state.beforeChunk = async () => {
        cancellation.abort();
      };
    try {
      const signature = tenant.objects.get(LOGO_OBJECT).signature;
      await expect(
        tenant.store.upload(file(), cancellation.signal),
      ).rejects.toThrow();
      expect(tenant.objects.get(LOGO_OBJECT).signature).toBe(signature);
    } finally {
      tenant.close();
    }
  }
});

test("logo manifests reject unbound references and damaged blocks", async () => {
  const tenant = await fixture();
  try {
    await tenant.store.upload(file());
    const saved = (await tenant.plain(LOGO_COLLECTION, LOGO_OBJECT)).image;
    for (const bad of [
      { ...saved, extra: true },
      { ...saved, mimeType: "image/svg+xml" },
      { ...saved, width: 0 },
      { ...saved, height: null },
      { ...saved, fileName: "../logo.png" },
      { ...saved, id: "2" },
      { ...saved, content: { ...saved.content, size: 11 * 1024 * 1024 } },
    ])
      expect(() => logoImage(bad)).toThrow();
    expect(() =>
      logoPayload({ ...empty, image: saved }, "organization:logo:other"),
    ).toThrow();
    expect(() =>
      logoPayload(
        { ...empty, image: saved, issue: "legacy-incomplete" },
        LOGO_OBJECT,
      ),
    ).toThrow();
    expect(() =>
      readLogoResource("sortsys-logo:0:" + saved.content.version),
    ).toThrow();
    await expect(tenant.store.blob(saved.id, "a".repeat(32))).rejects.toThrow();
    const block = tenant.chunks.get(saved.content.parts[0].id);
    block.envelope.ciphertext = block.envelope.ciphertext.slice(0, -4) + "AAAA";
    await expect(
      tenant.store.blob(saved.id, saved.content.version),
    ).rejects.toThrow();
  } finally {
    tenant.close();
  }
});

test("the facade revokes decrypted logo URLs when the crypto context ends", async () => {
  const tenant = await fixture();
  const client = createBusinessClient(tenant.client, {
    productDriver: duckDriver,
    logoProcessor: prepare,
  });
  try {
    await client.logo.upload(file());
    const [status, error] = await client.query(
      "settings.tenantLogo.get",
      undefined,
    );
    expect(error).toBeNull();
    const reference = readLogoResource(status.downloadUrl);
    const context = client.logo.context();
    const resource = await client.logo.url(reference.id, reference.version);
    expect((await fetch(resource.url)).ok).toBe(true);
    await lockCryptoSession();
    expect(context.aborted).toBe(true);
    await expect(fetch(resource.url)).rejects.toThrow();
    resource.dispose();
    await expect(
      client.logo.blob(reference.id, reference.version),
    ).rejects.toThrow();
  } finally {
    client.dispose();
    tenant.close();
  }
});

test("legacy logo decoding distinguishes missing, incomplete and valid source references", () => {
  expect(legacyLogo({ status: "none" })).toEqual({ kind: "none" });
  for (const status of ["uploading", "queued", "processing", "failed"]) {
    expect(legacyLogo({ status })).toEqual({ kind: "incomplete" });
  }
  expect(
    legacyLogo(
      JSON.stringify({
        status: "ready",
        objectKey: "logos/private.webp",
        fileName: "Logo.webp",
        mimeType: "image/webp",
      }),
    ).key,
  ).toBe("logos/private.webp");
  for (const invalid of [
    null,
    {},
    { status: "surprise" },
    { status: "ready", objectKey: "" },
  ]) {
    expect(() => legacyLogo(invalid)).toThrow();
  }
});

test("stable migrated content resumes verified blocks without rewriting and rejects different bytes", async () => {
  const tenant = await fixture();
  const signal = new AbortController().signal;
  const version = "b".repeat(32);
  try {
    const blob = new Blob([png], { type: "image/png" });
    const original = await storeFileContent(
      tenant.client,
      "organization",
      "2",
      blob,
      version,
      signal,
      { resume: true },
    );
    const published = tenant.calls.filter(
      (call) => call.path === "zerotrust.fileChunks.putMany",
    ).length;
    const resumed = await storeFileContent(
      tenant.client,
      "organization",
      "2",
      blob,
      version,
      signal,
      { resume: true },
    );
    expect(resumed).toEqual(original);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.fileChunks.putMany"),
    ).toHaveLength(published);
    await verifyFileContent(
      tenant.client,
      "organization",
      "2",
      original,
      blob,
      signal,
    );
    const changed = png.slice();
    changed[changed.length - 1] ^= 1;
    await expect(
      storeFileContent(
        tenant.client,
        "organization",
        "2",
        new Blob([changed]),
        version,
        signal,
        { resume: true },
      ),
    ).rejects.toThrow();
  } finally {
    tenant.close();
  }
});
