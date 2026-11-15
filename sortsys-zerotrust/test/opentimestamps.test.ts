import { expect, test } from "bun:test";
import {
  applyOtsOperation,
  evaluateOtsProof,
  mergeOtsNodes,
  otsCalendar,
  OTS_CALENDARS,
  OpenTimestampUnavailable,
  parseOtsProof,
  serializeOtsProof,
  serializeOtsTree,
  stampOtsDigest,
  upgradeOtsProof,
  verifyOtsBitcoin,
  type OtsClaim,
  type OtsNode,
} from "../src/sortsys";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const from = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
type Vector = {
  name: string;
  digest: string;
  proof: string;
  attestations: {
    tag: string;
    message: string;
    height?: number;
    calendar?: string;
  }[];
};
const vectors: { files: Vector[] } = await Bun.file(
  new URL("./fixtures/opentimestamps.json", import.meta.url),
).json();
const pending = (calendar: string = OTS_CALENDARS[0]): OtsNode => {
  const data = new TextEncoder().encode(calendar);
  return {
    attestations: [
      {
        tag: from("83dfe30d2ef90c8e"),
        payload: new Uint8Array([data.length, ...data]),
      },
    ],
    edges: [],
  };
};
const bitcoin = (height = 1): OtsNode => ({
  attestations: [
    { tag: from("0588960d73d71901"), payload: new Uint8Array([height]) },
  ],
  edges: [],
});
const encode = (node: OtsNode, digest = new Uint8Array(32)) =>
  serializeOtsProof({ hash: 8, digest, node });

function vectorAttestation(claim: OtsClaim): Vector["attestations"][number] {
  const message = hex(claim.message);
  switch (claim.kind) {
    case "bitcoin":
      return { message, tag: "0588960d73d71901", height: claim.height };
    case "pending":
      return { message, tag: "83dfe30d2ef90c8e", calendar: claim.calendar };
    case "unknown":
      return { message, tag: claim.tag };
  }
}

for (const vector of vectors.files) {
  test(`official OTS commitment paths and unknown attestations survive ${vector.name}`, async () => {
    const data = new Uint8Array(Buffer.from(vector.proof, "base64"));
    const expected = from(vector.digest);
    const proof = parseOtsProof(data, expected);
    const claims = await evaluateOtsProof(data, expected);

    expect(proof.digest).toEqual(expected);
    expect(serializeOtsProof(proof)).toEqual(data);
    expect(claims.map(vectorAttestation)).toEqual(vector.attestations);
  });
}

test("a proof cannot substitute another file digest, ignore trailing bytes or accept truncation", () => {
  const data = new Uint8Array(Buffer.from(vectors.files[0]!.proof, "base64"));
  for (let length = 0; length < data.length; length++) {
    expect(() => parseOtsProof(data.slice(0, length))).toThrow();
  }
  expect(() => parseOtsProof(new Uint8Array([...data, 0]))).toThrow();
  expect(() => parseOtsProof(data, new Uint8Array(32))).toThrow();
  const bad = data.slice();
  bad[0] = 1;
  expect(() => parseOtsProof(bad)).toThrow();
});
test("proof evaluation bounds message growth, recursion and branching and supports cancellation", async () => {
  const growing = {
    attestations: [],
    edges: [
      {
        operation: { tag: 240 as const, argument: new Uint8Array(4096) },
        node: pending(),
      },
    ],
  };
  await expect(evaluateOtsProof(encode(growing))).rejects.toThrow();
  const cyclic: OtsNode = { attestations: [], edges: [] };
  cyclic.edges.push({ operation: { tag: 8 }, node: cyclic });
  expect(() => encode(cyclic)).toThrow();
  expect(() =>
    encode({
      attestations: Array(4096).fill(pending().attestations[0]),
      edges: [],
    }),
  ).toThrow();
  await expect(
    evaluateOtsProof(encode(pending()), undefined, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(() => parseOtsProof(new Uint8Array(256 * 1024 + 1))).toThrow();
});
test("a well-formed Bitcoin assertion is unverified until a canonical by-height source confirms it", async () => {
  const vector = vectors.files[0]!;
  const data = new Uint8Array(Buffer.from(vector.proof, "base64"));
  const digest = from(vector.digest);
  const expected = vector.attestations.find(
    (value) => value.height !== undefined,
  )!;
  expect(await verifyOtsBitcoin(data, digest)).toEqual({
    status: "unverified",
  });
  const header = new Uint8Array(80);
  header.set(from(expected.message), 36);
  new DataView(header.buffer).setUint32(68, 1432812245, true);
  expect(
    await verifyOtsBitcoin(data, digest, async (height) => ({
      height,
      header,
    })),
  ).toEqual({
    status: "verified",
    height: expected.height!,
    unixTime: 1432812245,
  });
  expect(
    await verifyOtsBitcoin(data, digest, async (height) => ({
      height: height + 1,
      header,
    })),
  ).toEqual({ status: "unverified" });
  const mismatch = header.slice();
  mismatch[36] = mismatch[36]! ^ 1;
  expect(
    await verifyOtsBitcoin(data, digest, async (height) => ({
      height,
      header: mismatch,
    })),
  ).toEqual({ status: "unverified" });
  expect(await verifyOtsBitcoin(encode(pending()), new Uint8Array(32))).toEqual(
    { status: "pending", calendars: [OTS_CALENDARS[0]] },
  );
});
test("the stamper sends a nonce-blinded digest without identifiers, credentials or document contents", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const digest = new Uint8Array(32).fill(7);
  const proof = await stampOtsDigest(digest, {
    async fetch(url, options) {
      calls.push({ url, options });
      if (url.startsWith(OTS_CALENDARS[0])) {
        throw new Error("Calendar unavailable");
      }
      return new Response(serializeOtsTree(pending(OTS_CALENDARS[1])));
    },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.options.body).toBeInstanceOf(Uint8Array);
  const body = calls[0]!.options.body as Uint8Array;
  expect(body.length).toBe(32);
  expect(body).not.toEqual(digest);
  for (const call of calls) {
    expect(call.options.credentials).toBe("omit");
    expect(call.options.referrerPolicy).toBe("no-referrer");
    expect(call.options.redirect).toBe("error");
    expect(call.url.endsWith("/digest")).toBe(true);
  }
  expect((await evaluateOtsProof(proof, digest))[0]).toMatchObject({
    kind: "pending",
    calendar: OTS_CALENDARS[1],
  });
  expect(parseOtsProof(proof).digest).toEqual(digest);
});
test("all-calendar failure and cancellation leave no falsely confirmed receipt", async () => {
  await expect(
    stampOtsDigest(new Uint8Array(32), {
      async fetch() {
        throw new Error("offline");
      },
    }),
  ).rejects.toBeInstanceOf(OpenTimestampUnavailable);
  await expect(
    stampOtsDigest(new Uint8Array(32), {
      signal: AbortSignal.abort(),
      async fetch() {
        throw new Error("must not run");
      },
    }),
  ).rejects.toThrow();
  await expect(
    stampOtsDigest(new Uint8Array(32), {
      async fetch() {
        return new Response(new Uint8Array(256 * 1024 + 1));
      },
    }),
  ).rejects.toBeInstanceOf(OpenTimestampUnavailable);
});
test("receipt upgrades preserve previous attestations and repeated upgrades are idempotent", async () => {
  const digest = new Uint8Array(32);
  const source = encode(pending());
  const calls: string[] = [];
  const options = {
    async fetch(url: string) {
      calls.push(url);
      return new Response(serializeOtsTree(bitcoin()));
    },
  };
  const upgraded = await upgradeOtsProof(source, digest, options);
  const claims = await evaluateOtsProof(upgraded, digest);
  expect(claims.map((claim) => claim.kind).sort()).toEqual([
    "bitcoin",
    "pending",
  ]);
  expect(calls[0]).toBe(`${OTS_CALENDARS[0]}/timestamp/${hex(digest)}`);
  expect(await upgradeOtsProof(upgraded, digest, options)).toEqual(upgraded);
  expect(
    await upgradeOtsProof(source, digest, {
      async fetch() {
        throw new Error("calendar down");
      },
    }),
  ).toEqual(source);
  const merged = mergeOtsNodes(pending(), bitcoin());
  expect(serializeOtsTree(mergeOtsNodes(merged, merged))).toEqual(
    serializeOtsTree(merged),
  );
});
test("pending attestations cannot trigger arbitrary hosts, redirects, credentials, ports or paths", async () => {
  for (const value of [
    "http://127.0.0.1",
    "https://alice.btc.calendar.opentimestamps.org.evil.test",
    "https://alice.btc.calendar.opentimestamps.org/private",
    "https://alice.btc.calendar.opentimestamps.org:444",
    "https://user@alice.btc.calendar.opentimestamps.org",
    "https://alice.btc.calendar.opentimestamps.org?token=secret",
  ]) {
    expect(otsCalendar(value)).toBeNull();
  }
  expect(otsCalendar("http://alice.btc.calendar.opentimestamps.org")).toBe(
    OTS_CALENDARS[0],
  );
  let called = false;
  const proof = encode(pending("http://127.0.0.1"));
  expect(
    await upgradeOtsProof(proof, new Uint8Array(32), {
      async fetch() {
        called = true;
        throw new Error("must not run");
      },
    }),
  ).toEqual(proof);
  expect(called).toBe(false);
});
test("hash and byte operations retain literal bytes and reject unknown cryptographic operations", async () => {
  expect(
    await applyOtsOperation(new Uint8Array([0, 255]), { tag: 242 }),
  ).toEqual(new Uint8Array([255, 0]));
  expect(
    new TextDecoder().decode(
      await applyOtsOperation(new Uint8Array([0, 255]), { tag: 243 }),
    ),
  ).toBe("00ff");
  expect(
    hex(await applyOtsOperation(new TextEncoder().encode("abc"), { tag: 8 })),
  ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(
    hex(await applyOtsOperation(new TextEncoder().encode("abc"), { tag: 3 })),
  ).toBe("8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
});
