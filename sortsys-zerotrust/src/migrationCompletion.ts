import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "./encoding";

export type MigrationEntry = {
  kind: string;
  id: string;
  revision: string;
  hash: string;
};
export type MigrationDigest = { count: string; hash: string };
export type MigrationSeal = {
  tenant: string;
  migration: string;
  schema: string;
  generation: string;
  policyVersion: string;
  catalogVersion: string;
  source: MigrationDigest;
  target: MigrationDigest;
  author: string;
  proof: string;
};

function count(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  ) {
    throw new InvalidProtectedData();
  }
}

/** Constant-memory commitment to an ASCII-ordered inventory. Duplicate,
 * missing, reordered or changed entries produce a different commitment. */
export class MigrationInventory {
  private readonly state = sha256
    .create()
    .update(frame("zerotrust/migration-inventory/v1", []));
  private previous: string | undefined;
  private length = 0n;
  private result: MigrationDigest | undefined;

  add(entry: MigrationEntry): void {
    identifier(entry.kind);
    identifier(entry.id);
    count(entry.revision);
    sized(entry.hash, 32);
    const key = `${entry.kind}\0${entry.id}`;
    if (this.result || (this.previous !== undefined && key <= this.previous))
      throw new InvalidProtectedData();
    this.state.update(
      frame("zerotrust/migration-entry/v1", [
        entry.kind,
        entry.id,
        entry.revision,
        entry.hash,
      ]),
    );
    this.previous = key;
    this.length++;
  }

  finish(): MigrationDigest {
    this.result ??= {
      count: String(this.length),
      hash: base64(
        sha256(
          frame("zerotrust/migration-inventory-end/v1", [
            String(this.length),
            base64(this.state.digest()),
          ]),
        ),
      ),
    };
    return { ...this.result };
  }
}

export function migrationSealFrame(
  input: Omit<MigrationSeal, "proof"> | MigrationSeal,
): Uint8Array<ArrayBuffer> {
  for (const value of [
    input.tenant,
    input.migration,
    input.schema,
    input.author,
  ])
    identifier(value);
  for (const value of [
    input.generation,
    input.policyVersion,
    input.catalogVersion,
  ])
    revision(value);
  for (const value of [input.source, input.target]) {
    record(value, ["count", "hash"]);
    count(value.count);
    sized(value.hash, 32);
  }
  return frame("zerotrust/migration-seal/v1", [
    input.tenant,
    input.migration,
    input.schema,
    input.generation,
    input.policyVersion,
    input.catalogVersion,
    input.source.count,
    input.source.hash,
    input.target.count,
    input.target.hash,
    input.author,
  ]);
}

/** This is an authority's attestation of client-side validation, not a
 * server-side proof of the semantics of hidden plaintext. */
export function migrationSeal(input: unknown): MigrationSeal {
  const value = record(input, [
    "tenant",
    "migration",
    "schema",
    "generation",
    "policyVersion",
    "catalogVersion",
    "source",
    "target",
    "author",
    "proof",
  ]) as MigrationSeal;
  migrationSealFrame(value);
  sized(value.proof, 64);
  return { ...value, source: { ...value.source }, target: { ...value.target } };
}
