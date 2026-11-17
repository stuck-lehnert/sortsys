import { InvalidProtectedData, record } from "./encoding";

export type RecoveryLimits = {
  domains: number;
  keyGenerations: number;
};

export type RecoveryInventory = {
  domains: number;
  keyGenerations: number;
};

export const DEFAULT_RECOVERY_LIMITS: Readonly<RecoveryLimits> = Object.freeze({
  domains: 2_000,
  keyGenerations: 50_000,
});

function count(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new InvalidProtectedData();
  }
}

export function recoveryInventory(
  input: unknown,
  limits: RecoveryLimits = DEFAULT_RECOVERY_LIMITS,
): RecoveryInventory {
  const value = record(input, ["domains", "keyGenerations"]);
  const bounds = record(limits, ["domains", "keyGenerations"]);
  count(bounds.domains);
  count(bounds.keyGenerations);
  count(value.domains);
  count(value.keyGenerations);
  if (
    value.domains > bounds.domains ||
    value.keyGenerations < value.domains ||
    value.keyGenerations > bounds.keyGenerations
  ) {
    throw new InvalidProtectedData();
  }
  return { domains: value.domains, keyGenerations: value.keyGenerations };
}

/** Reserve both the publication and one subsequent tenant-wide key rotation.
 * The caller must publish this counter atomically with the actual key records. */
export function reserveRecoveryInventory(
  input: RecoveryInventory,
  addition: RecoveryInventory,
  limits: RecoveryLimits = DEFAULT_RECOVERY_LIMITS,
): RecoveryInventory {
  const current = recoveryInventory(input, limits);
  recoveryInventory(addition, limits);
  const next = recoveryInventory(
    {
      domains: current.domains + addition.domains,
      keyGenerations: current.keyGenerations + addition.keyGenerations,
    },
    limits,
  );
  if (next.keyGenerations + next.domains > limits.keyGenerations) {
    throw new InvalidProtectedData();
  }
  return next;
}
