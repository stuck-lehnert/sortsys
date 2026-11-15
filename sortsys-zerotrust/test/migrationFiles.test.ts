import { expect, test } from "bun:test";
import vector from "./fixtures/framework.json";
import {
  base64,
  createIdentity,
  importSigningKey,
  migrationFileReceipt,
  migrationFileReceiptFrame,
  sign,
  verify,
} from "../src/index";

test("a portable receipt binds every public reference and the ordered blocks", async () => {
  const receipt = migrationFileReceipt(vector.fileReceipt);
  const signer = await importSigningKey(vector.signer.signingKey);
  await verify(signer, receipt.proof, migrationFileReceiptFrame(receipt));
  for (const change of [
    { tenant: "practice:other" },
    { migration: "migration:other" },
    { generation: "2" },
    { source: "source:other" },
    { bytes: "262152" },
    { object: "archive:other" },
    { revision: "2" },
    { ciphertextHash: receipt.blocks[0]!.hash },
    { author: "doctor:other" },
    { blocks: [...receipt.blocks].reverse() },
    { blocks: receipt.blocks.slice(1) },
    { blocks: [{ ...receipt.blocks[0]!, id: "block:other" }, receipt.blocks[1]!] },
    { blocks: [{ ...receipt.blocks[0]!, hash: receipt.blocks[1]!.hash }, receipt.blocks[1]!] },
  ]) {
    await expect(verify(signer, receipt.proof, migrationFileReceiptFrame({ ...receipt, ...change }))).rejects.toThrow();
  }
});

test("receipts reject ambiguous sizes, duplicate block IDs and unexpected fields", () => {
  const receipt = migrationFileReceipt(vector.fileReceipt);
  for (const bytes of ["-1", "01", "1.0", "9223372036854775808"]) {
    expect(() => migrationFileReceipt({ ...receipt, bytes })).toThrow();
  }
  for (const change of [
    { blocks: [receipt.blocks[0], receipt.blocks[0]] },
    { blocks: [{ ...receipt.blocks[0], plaintext: "private" }] },
    { filename: "confidential.pdf" },
    { proof: "invalid" },
  ]) {
    expect(() => migrationFileReceipt({ ...receipt, ...change })).toThrow();
  }
  receipt.blocks[0]!.id = "changed:copy";
  expect(vector.fileReceipt.blocks[0]!.id).toBe("block:scan:0");
});

test("a zero-byte original has a signed manifest and no blocks", async () => {
  const identity = await createIdentity();
  const empty = {
    ...vector.fileReceipt,
    bytes: "0",
    blocks: [],
    ciphertextHash: base64(new Uint8Array(32)),
  };
  empty.proof = await sign(identity.signingKey.privateKey, migrationFileReceiptFrame(empty));
  const receipt = migrationFileReceipt(empty);
  await verify(identity.signingKey.publicKey, receipt.proof, migrationFileReceiptFrame(receipt));
  expect(receipt.blocks).toEqual([]);
});
