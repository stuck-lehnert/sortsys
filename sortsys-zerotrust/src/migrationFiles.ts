import { base64, frame, identifier, InvalidProtectedData, record, revision, sized } from "./encoding";

export type MigrationFileBlock = { id: string; hash: string };
export type MigrationFileReceipt = {
  tenant: string;
  migration: string;
  generation: string;
  source: string;
  bytes: string;
  object: string;
  revision: string;
  ciphertextHash: string;
  blocks: MigrationFileBlock[];
  author: string;
  proof: string;
};

export function migrationFileReceiptFrame(
  input: Omit<MigrationFileReceipt, "proof"> | MigrationFileReceipt,
): Uint8Array<ArrayBuffer> {
  for (const value of [input.tenant, input.migration, input.source, input.object, input.author]) identifier(value);
  revision(input.generation);
  revision(input.revision);
  if (typeof input.bytes !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(input.bytes) || BigInt(input.bytes) > 9223372036854775807n) {
    throw new InvalidProtectedData();
  }
  sized(input.ciphertextHash, 32);
  if (!Array.isArray(input.blocks) || input.blocks.length > 4096) throw new InvalidProtectedData();
  const ids = new Set<string>();
  const blocks = input.blocks.map(item => {
    const block = record(item, ["id", "hash"]);
    identifier(block.id);
    if (ids.has(block.id)) throw new InvalidProtectedData();
    ids.add(block.id);
    if (typeof block.hash !== "string") throw new InvalidProtectedData();
    sized(block.hash, 32);
    return base64(frame("sortsys/migration-file-block/v1", [block.id, block.hash]));
  });
  return frame("sortsys/migration-file-receipt/v1", [
    input.tenant, input.migration, input.generation, input.source, input.bytes,
    input.object, input.revision, input.ciphertextHash, input.author,
    base64(frame("sortsys/migration-file-blocks/v1", blocks)),
  ]);
}

export function migrationFileReceipt(input: unknown): MigrationFileReceipt {
  const value = record(input, [
    "tenant", "migration", "generation", "source", "bytes", "object", "revision",
    "ciphertextHash", "blocks", "author", "proof",
  ]) as MigrationFileReceipt;
  migrationFileReceiptFrame(value);
  sized(value.proof, 64);
  return { ...value, blocks: value.blocks.map(block => ({ ...block })) };
}
