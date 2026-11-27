import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  validateBase64Size,
} from "./encoding";
import { sign, verify } from "./identity";
import { encryptedObject } from "./objects";

export type HistoryOrigin = { source: string; occurredMicros: string };
export type MigrationOrigin = {
  generation: string;
  signature: string;
  history?: HistoryOrigin;
};
export function historyInstant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value) ||
    value.length > 19 ||
    BigInt(value) < -62135596800000000n ||
    BigInt(value) > 253402300799999999n
  )
    throw new InvalidProtectedData();
}
function historyOrigin(input: unknown): HistoryOrigin {
  const value = record(input, ["source", "occurredMicros"]);
  revision(value.source);
  historyInstant(value.occurredMicros);
  return value as HistoryOrigin;
}
export function migrationOrigin(input: unknown): MigrationOrigin {
  const withHistory =
    !!input && typeof input === "object" && Object.hasOwn(input, "history");
  const value = record(input, [
    "generation",
    "signature",
    ...(withHistory ? ["history"] : []),
  ]);
  revision(value.generation);
  validateBase64Size(value.signature, 64);
  return {
    generation: value.generation as string,
    signature: value.signature,
    ...(withHistory ? { history: historyOrigin(value.history) } : {}),
  };
}
export function migrationOriginFrame(
  input: unknown,
  generation: string,
  history?: HistoryOrigin,
): Uint8Array<ArrayBuffer> {
  const value = encryptedObject(input);
  revision(generation);
  if (value.revision !== "1") throw new InvalidProtectedData();
  if (value.object.startsWith("legacy-activity:") && !history)
    throw new InvalidProtectedData();
  const fields = [
    value.tenant,
    value.scope,
    value.facet,
    value.object,
    value.revision,
    value.signature,
    generation,
  ];
  if (history) {
    const origin = historyOrigin(history);
    if (
      !value.object.startsWith("legacy-activity:") ||
      value.format !== "sortsys-object-v1"
    )
      throw new InvalidProtectedData();
    return frame("sortsys/migration-history/v1", [
      ...fields,
      origin.source,
      origin.occurredMicros,
    ]);
  }
  return frame("sortsys/migration-origin/v1", fields);
}
/** The original author is not replaced. The tenant authority attests only that
 * this exact first publication belongs to the verified legacy conversion. */
export async function attestMigrationOrigin(
  input: unknown,
  generation: string,
  authority: CryptoKey,
  history?: HistoryOrigin,
): Promise<MigrationOrigin> {
  return {
    generation,
    signature: await sign(
      authority,
      migrationOriginFrame(input, generation, history),
    ),
    ...(history ? { history: historyOrigin(history) } : {}),
  };
}
export async function verifyMigrationOrigin(
  input: unknown,
  value: unknown,
  authority: (generation: string) => CryptoKey,
): Promise<MigrationOrigin> {
  const origin = migrationOrigin(value);
  await verify(
    authority(origin.generation),
    origin.signature,
    migrationOriginFrame(input, origin.generation, origin.history),
  );
  return origin;
}
export function historySequence(value: unknown): asserts value is string {
  identifier(value);
  if (value !== "0") revision(value);
}
