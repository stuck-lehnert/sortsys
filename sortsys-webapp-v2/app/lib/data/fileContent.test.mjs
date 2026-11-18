import { afterEach, expect, test } from "bun:test";
import { createClient, RpcClientError } from "@sortsys/v2-client";
import superjson from "superjson";
import {
  base64,
  digest,
  objectFrame,
  signedPacketFrame,
  unbase64,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import {
  loadFileContent,
  storeFileContent,
  verifyFileContent,
} from "./fileContent";
import { chunkCollection, FILE_CHUNK_BYTES } from "./projectFileData";
import { protectedCollection } from "./protectedObjects";
import { ramCache } from "./ramCache";
import { protectedTenant } from "./testing/protectedTenant.mjs";

const namespace = "organization";
const file = "2";
const version = "b".repeat(32);
const area = chunkCollection(namespace);

afterEach(() => lockCryptoSession());

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function source(blocks = 9) {
  const bytes = new Uint8Array((blocks - 1) * FILE_CHUNK_BYTES + 29);
  for (let index = 0; index < blocks; index++) {
    const offset = index * FILE_CHUNK_BYTES;
    bytes.fill(index + 1, offset, offset + FILE_CHUNK_BYTES);
    bytes.set(new TextEncoder().encode(`Private file block ${index}`), offset);
  }
  return new Blob([bytes], { type: "application/octet-stream" });
}

async function fixture(blocks = 9) {
  const tenant = await protectedTenant([area]);
  const controller = new AbortController();
  const signal = controller.signal;
  const blob = source(blocks);
  const manifest = await storeFileContent(
    tenant.client,
    namespace,
    file,
    blob,
    version,
    signal,
  );
  return { ...tenant, blob, manifest, signal, close: () => controller.abort() };
}

async function packetHash(envelope) {
  return digest(signedPacketFrame(objectFrame(envelope), envelope.signature));
}

// This adapter exercises the real RPC transport and browser cryptography.
// Its storage boundary is a protocol fixture, not the native DuckDB service.
function wireClient(tenant) {
  const requests = [];
  const client = createClient("https://file-blocks.test", "file-block-test", {
    cache: ramCache(),
    fetch: async (input, options) => {
      const url = new URL(String(input));
      const paths = url.pathname.slice(1).split(",");
      const encoded = JSON.parse(
        options?.method === "POST"
          ? String(options.body)
          : url.searchParams.get("input"),
      );
      const inputs = paths.map((_, index) =>
        superjson.deserialize(encoded[index]),
      );
      requests.push({ paths, inputs, body: String(options?.body ?? "") });
      const replies = await Promise.all(
        paths.map(async (path, index) => {
          const call = path.endsWith(".put") ? "mutate" : "query";
          const [result, error] = await tenant.client[call](
            path,
            inputs[index],
          );
          if (error) {
            const shape = RpcClientError.from(error).shape;
            return { error: superjson.serialize(shape) };
          }
          return { result: { data: superjson.serialize(result) } };
        }),
      );
      return new Response(JSON.stringify(replies));
    },
  });
  client.setToken("protocol-fixture-session");
  return { client, requests };
}

function blockReads(requests) {
  return requests.flatMap(({ paths, inputs }) =>
    inputs
      .filter((_, index) => paths[index] === "zerotrust.fileChunks.getMany")
      .map((input) => input.ids.length),
  );
}

test("file reads and verification share bounded HTTP batches and preserve byte order", async () => {
  const tenant = await fixture();
  const { client, requests } = wireClient(tenant);
  try {
    for (const operation of ["load", "verify"]) {
      requests.length = 0;
      if (operation === "load") {
        const loaded = await loadFileContent(
          client,
          namespace,
          file,
          tenant.manifest,
          tenant.blob.type,
          tenant.signal,
        );
        expect(loaded.type).toBe(tenant.blob.type);
        expect(await loaded.arrayBuffer()).toEqual(
          await tenant.blob.arrayBuffer(),
        );
      } else {
        await verifyFileContent(
          client,
          namespace,
          file,
          tenant.manifest,
          tenant.blob,
          tenant.signal,
        );
      }
      expect(blockReads(requests)).toEqual([4, 4, 1]);
      expect(
        requests.some((request) =>
          request.paths.includes("zerotrust.fileChunks.get"),
        ),
      ).toBe(false);
      expect(JSON.stringify(requests)).not.toContain("Private file block");
    }
  } finally {
    client.setToken(null);
    tenant.close();
  }
});

test("parallel staging verifies lost acknowledgements and resumes without replacing blocks", async () => {
  const tenant = await protectedTenant([area]);
  const { client, requests } = wireClient(tenant);
  const controller = new AbortController();
  const blob = source();
  const firstWave = deferred();
  let active = 0;
  let maximum = 0;
  tenant.state.beforeChunk = async () => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 4) firstWave.resolve();
    await firstWave.promise;
    active--;
  };
  tenant.state.loseChunkReply = true;
  try {
    const manifest = await storeFileContent(
      client,
      namespace,
      file,
      blob,
      version,
      controller.signal,
    );
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(tenant.chunks.size).toBe(manifest.parts.length);
    expect(blockReads(requests)).toEqual([4, 4, 1]);
    const writes = tenant.calls.filter(
      (call) => call.path === "zerotrust.fileChunks.put",
    ).length;
    expect(
      await storeFileContent(
        client,
        namespace,
        file,
        blob,
        version,
        controller.signal,
        { resume: true },
      ),
    ).toEqual(manifest);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.fileChunks.put"),
    ).toHaveLength(writes);
    await verifyFileContent(
      client,
      namespace,
      file,
      manifest,
      blob,
      controller.signal,
    );
    const uploads = requests.filter((request) =>
      request.paths.includes("zerotrust.fileChunks.put"),
    );
    expect(
      uploads.every(
        (request) =>
          new TextEncoder().encode(request.body).length <= 1024 * 1024,
      ),
    ).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("Private file block");
    expect(JSON.stringify(requests)).not.toContain(
      base64(
        new Uint8Array(await blob.slice(0, FILE_CHUNK_BYTES).arrayBuffer()),
      ),
    );
    const changed = new Uint8Array(await blob.arrayBuffer());
    changed[changed.length - 1] ^= 1;
    await expect(
      storeFileContent(
        client,
        namespace,
        file,
        new Blob([changed]),
        version,
        controller.signal,
        { resume: true },
      ),
    ).rejects.toThrow();
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.fileChunks.put"),
    ).toHaveLength(writes);
  } finally {
    controller.abort();
    client.setToken(null);
  }
});

test("a failed block batch stops the download before requesting the next group", async () => {
  const tenant = await fixture();
  const original = tenant.client.query.bind(tenant.client);
  const reads = [];
  tenant.client.query = async (path, input, options) => {
    if (path !== "zerotrust.fileChunks.getMany")
      return original(path, input, options);
    reads.push(...input.ids);
    return [null, new Error("Denied file block")];
  };
  try {
    await expect(
      loadFileContent(
        tenant.client,
        namespace,
        file,
        tenant.manifest,
        tenant.blob.type,
        tenant.signal,
      ),
    ).rejects.toThrow("Denied file block");
    expect(reads).toEqual(
      tenant.manifest.parts.slice(0, 4).map((part) => part.id),
    );
  } finally {
    tenant.close();
  }
});

test("cancellation and account replacement discard late parallel reads", async () => {
  for (const end of ["abort", "lock"]) {
    const tenant = await fixture();
    const controller = new AbortController();
    const original = tenant.client.query.bind(tenant.client);
    const entered = deferred();
    const release = deferred();
    let reads = 0;
    tenant.client.query = async (path, input, options) => {
      if (path !== "zerotrust.fileChunks.getMany")
        return original(path, input, options);
      reads += input.ids.length;
      if (reads === 4) entered.resolve();
      await release.promise;
      return original(path, input, options);
    };
    const pending = loadFileContent(
      tenant.client,
      namespace,
      file,
      tenant.manifest,
      tenant.blob.type,
      controller.signal,
    );
    const outcome = Promise.allSettled([pending]);
    try {
      await entered.promise;
      if (end === "abort") controller.abort();
      else lockCryptoSession();
      release.resolve();
      expect((await outcome)[0].status).toBe("rejected");
      expect(reads).toBe(4);
    } finally {
      release.resolve();
      await outcome;
      tenant.close();
    }
  }
});

test("cancelled parallel uploads drain started writes and erase their plaintext buffers", async () => {
  const tenant = await protectedTenant([area]);
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const buffers = [];
  class ObservedBlob extends Blob {
    slice(...args) {
      const fragment = super.slice(...args);
      const read = fragment.arrayBuffer.bind(fragment);
      fragment.arrayBuffer = async () => {
        const buffer = await read();
        buffers.push(new Uint8Array(buffer));
        return buffer;
      };
      return fragment;
    }
  }
  const blob = new ObservedBlob([source()]);
  let started = 0;
  let active = 0;
  let settled = false;
  tenant.state.beforeChunk = async () => {
    started++;
    active++;
    if (started === 4) entered.resolve();
    await release.promise;
    active--;
  };
  const pending = storeFileContent(
    tenant.client,
    namespace,
    file,
    blob,
    version,
    controller.signal,
  );
  const outcome = pending.then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered.promise;
    controller.abort();
    expect(settled).toBe(false);
    release.resolve();
    expect(await outcome).toBe(controller.signal.reason);
    expect(started).toBe(4);
    expect(active).toBe(0);
    expect(buffers).toHaveLength(4);
    expect(
      buffers.every((buffer) => buffer.every((value) => value === 0)),
    ).toBe(true);
  } finally {
    release.resolve();
    await outcome;
    controller.abort();
  }
});

test("parallel reads reject changed hashes, forged signatures and signed blocks of the wrong length", async () => {
  const tenant = await fixture(2);
  const original = structuredClone(
    tenant.chunks.get(tenant.manifest.parts[0].id),
  );
  try {
    for (const corruption of ["hash", "signature", "size"]) {
      const stored = structuredClone(original);
      const manifest = structuredClone(tenant.manifest);
      if (corruption === "size") {
        const collection = await protectedCollection(
          tenant.client,
          area,
          tenant.signal,
        );
        try {
          const packet = await collection.packet(
            manifest.parts[0].id,
            {
              format: "sortsys-file-block-v1",
              data: base64(new Uint8Array(17)),
            },
            undefined,
            true,
          );
          stored.envelope = packet.envelope;
        } finally {
          collection.close();
        }
      } else {
        const signature = unbase64(stored.envelope.signature);
        signature[0] ^= 1;
        stored.envelope.signature = base64(signature);
      }
      if (corruption !== "hash")
        manifest.parts[0].hash = await packetHash(stored.envelope);
      tenant.chunks.set(manifest.parts[0].id, stored);
      await expect(
        loadFileContent(
          tenant.client,
          namespace,
          file,
          manifest,
          tenant.blob.type,
          tenant.signal,
        ),
      ).rejects.toThrow();
      await expect(
        verifyFileContent(
          tenant.client,
          namespace,
          file,
          manifest,
          null,
          tenant.signal,
        ),
      ).rejects.toThrow();
    }
  } finally {
    tenant.close();
  }
});
