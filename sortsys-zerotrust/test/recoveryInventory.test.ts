import { expect, test } from "bun:test";
import {
  DEFAULT_RECOVERY_LIMITS,
  recoveryInventory,
  reserveRecoveryInventory,
  rotateRecoveryInventory,
} from "../src/index";
import fixture from "./fixtures/recovery-inventory.json";

test("browser and server use the same inventory capacity vectors", () => {
  expect(DEFAULT_RECOVERY_LIMITS).toEqual(fixture.limits);
  for (const vector of fixture.cases) {
    if (vector.expected === null) {
      expect(() =>
        reserveRecoveryInventory(
          vector.current,
          vector.addition,
          fixture.limits,
        ),
      ).toThrow();
    } else {
      expect(
        reserveRecoveryInventory(
          vector.current,
          vector.addition,
          fixture.limits,
        ),
      ).toEqual(vector.expected);
    }
  }
});

test("browser and server use the same recovery rotation vectors", () => {
  for (const { name, current, expected } of fixture.rotations) {
    const rotate = () => rotateRecoveryInventory(current, fixture.limits);
    if (expected === null) {
      expect(rotate, name).toThrow();
    } else {
      expect(rotate(), name).toEqual(expected);
    }
  }
});

test("inventory counters reject unknown fields, negative values, fractions and overflows", () => {
  for (const domains of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 32,
  ]) {
    expect(() => recoveryInventory({ domains, keyGenerations: 1 })).toThrow();
  }
  expect(() =>
    recoveryInventory({ domains: 1, keyGenerations: 1, ignored: true }),
  ).toThrow();
  const unexpectedLimits = { domains: 1, keyGenerations: 1, ignored: true };
  expect(() =>
    recoveryInventory({ domains: 0, keyGenerations: 0 }, unexpectedLimits),
  ).toThrow();
  const maximum = 0xffff_ffff;
  expect(() =>
    reserveRecoveryInventory(
      { domains: 1, keyGenerations: maximum },
      { domains: 0, keyGenerations: 1 },
      { domains: maximum, keyGenerations: maximum },
    ),
  ).toThrow();
});

test("a caller can choose smaller capacity without changing the generic framework", () => {
  const current = { domains: 2, keyGenerations: 4 };
  const addition = { domains: 0, keyGenerations: 1 };
  expect(() =>
    reserveRecoveryInventory(current, addition, {
      domains: 2,
      keyGenerations: 6,
    }),
  ).toThrow();
  expect(current).toEqual({ domains: 2, keyGenerations: 4 });
  expect(addition).toEqual({ domains: 0, keyGenerations: 1 });
});
