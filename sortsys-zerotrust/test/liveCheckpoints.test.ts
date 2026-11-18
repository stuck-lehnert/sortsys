import { expect, test } from "bun:test";
import native from "../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-live-channels.json";
import {
  bytes,
  createIdentity,
  digest,
  liveCheckpoint,
  liveCheckpointFrame,
  base64,
  importSigningKey,
  livePosition,
  liveSequence,
  signLiveCheckpoint,
  verifyLiveCheckpoint,
} from "../src/sortsys";

async function signedCheckpoint() {
  const signer = await createIdentity();
  const room = {
    tenant: "test",
    scope: "commercial:2",
    document: "3",
    facet: "scope" as const,
  };
  const checkpoint = await signLiveCheckpoint(
    {
      ...room,
      sequence: "9007199254740993",
      covered: "9007199254740992",
      target: await digest(bytes("exact signed encrypted native publication")),
      generation: "1",
      policyVersion: "2",
      author: "user:1",
    },
    signer.signingKey.privateKey,
  );
  return { signer, room, checkpoint };
}

test("a live checkpoint binds the exact native target, room, position and writer", async () => {
  const { signer, room, checkpoint } = await signedCheckpoint();
  expect(
    await verifyLiveCheckpoint(checkpoint, room, signer.signingKey.publicKey),
  ).toEqual(checkpoint);

  const changes = [
    { target: await digest(bytes("different native publication")) },
    { sequence: "9007199254740994" },
    { covered: "9007199254740991" },
    { author: "user:2" },
    { generation: "2" },
    { policyVersion: "3" },
    { scope: "project:2" },
    { document: "4" },
    { tenant: "other" },
    { facet: "billing" },
  ];
  for (const change of changes) {
    await expect(
      verifyLiveCheckpoint(
        { ...checkpoint, ...change },
        room,
        signer.signingKey.publicKey,
      ),
    ).rejects.toThrow();
  }
  const stranger = await createIdentity();
  await expect(
    verifyLiveCheckpoint(checkpoint, room, stranger.signingKey.publicKey),
  ).rejects.toThrow();
});

test("checkpoint parsing rejects ambiguous positions, unsupported fields and impossible coverage", async () => {
  const { checkpoint } = await signedCheckpoint();
  for (const position of [
    null,
    0,
    "",
    "-1",
    "00",
    "01",
    "1.0",
    "9223372036854775808",
  ]) {
    expect(() => liveSequence(position)).toThrow();
  }
  for (const position of [
    "0",
    "1",
    "9007199254740993",
    "9223372036854775807",
  ]) {
    expect(() => liveSequence(position)).not.toThrow();
  }
  for (const change of [
    { covered: "9007199254740994" },
    { target: "not-a-digest" },
    { scope: "project:02" },
    { document: "0" },
    { author: "group:1" },
    { optional: null },
  ]) {
    expect(() => liveCheckpoint({ ...checkpoint, ...change })).toThrow();
  }
});

test("an empty room can confirm its native target without inventing a text edit", async () => {
  const { signer, room, checkpoint } = await signedCheckpoint();
  const empty = await signLiveCheckpoint(
    { ...checkpoint, sequence: "0", covered: "0" },
    signer.signingKey.privateKey,
  );
  expect(
    await verifyLiveCheckpoint(empty, room, signer.signingKey.publicKey),
  ).toEqual(empty);
});

test("restored channels bind positions and signed receipts to the same content fingerprint", async () => {
  const { signer, room, checkpoint } = await signedCheckpoint();
  const content = await digest(bytes("restored content head"));
  const other = await digest(bytes("another content head"));
  const restored = await signLiveCheckpoint(
    { ...checkpoint, content },
    signer.signingKey.privateKey,
  );
  expect(livePosition(`${content}:${restored.sequence}`)).toEqual({
    content,
    sequence: restored.sequence,
  });
  expect(livePosition(checkpoint.sequence).content).toBeNull();
  expect(() => livePosition(`${content}:01`)).toThrow();
  expect(() => livePosition(`wrong:${checkpoint.sequence}`)).toThrow();
  expect(
    await verifyLiveCheckpoint(restored, room, signer.signingKey.publicKey),
  ).toEqual(restored);
  await expect(
    verifyLiveCheckpoint(
      { ...restored, content: other },
      room,
      signer.signingKey.publicKey,
    ),
  ).rejects.toThrow();
  await expect(
    verifyLiveCheckpoint(
      { ...checkpoint, content },
      room,
      signer.signingKey.publicKey,
    ),
  ).rejects.toThrow();
});

test("the native checkpoint vector preserves its signature, channel and exact large counters", async () => {
  const checkpoint = liveCheckpoint(native.checkpoint);
  expect(base64(liveCheckpointFrame(checkpoint))).toBe(native.frame);
  const signer = await importSigningKey(native.publicKey);
  expect(
    await verifyLiveCheckpoint(
      checkpoint,
      {
        tenant: checkpoint.tenant,
        scope: checkpoint.scope,
        document: checkpoint.document,
        facet: checkpoint.facet,
      },
      signer,
    ),
  ).toEqual(checkpoint);
});

test("a replay manifest is bound to a fully covered native cursor and the exact channel", async () => {
  const { checkpoint, publicKey, frame } = native.replayVector;
  const signer = await importSigningKey(publicKey);
  const verified = await verifyLiveCheckpoint(checkpoint, checkpoint, signer);
  expect(base64(liveCheckpointFrame(verified))).toBe(frame);
  const invalid = [
    { covered: "1" },
    { format: "sortsys-live-checkpoint-v3" },
    { replay: { ...checkpoint.replay, facet: "offer-prices" } },
    { replay: { ...checkpoint.replay, hash: await digest(bytes("new hash")) } },
    { replay: { ...checkpoint.replay, keys: [{ facet: "scope", generation: "5" }] } },
    { content: undefined },
  ];
  for (const change of invalid) {
    await expect(
      verifyLiveCheckpoint({ ...checkpoint, ...change }, checkpoint, signer),
    ).rejects.toThrow();
  }
});
