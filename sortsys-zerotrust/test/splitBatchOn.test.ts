import { expect, test } from "bun:test";
import { splitBatchOn } from "../src";

const tooLarge = new Error("test batch size budget");
const denied = new Error("test read denied");
const exceedsBudget = (error: unknown) => error === tooLarge;

test("only oversized parts are split; read and output order are retained", async () => {
  const calls: number[][] = [];

  const result = await splitBatchOn(
    [5, 2, 8, 4, 3],
    async (batch) => {
      calls.push(batch);
      if (batch.length > 2) throw tooLarge;
      return batch.map(String);
    },
    exceedsBudget,
  );

  expect(calls).toEqual([[5, 2, 8, 4, 3], [5, 2, 8], [5, 2], [8], [4, 3]]);
  expect(result).toEqual(["5", "2", "8", "4", "3"]);
});

test("a rejected second part returns no result, and authorization errors never split", async () => {
  const calls: number[][] = [];

  const result = splitBatchOn(
    [1, 2, 3, 4],
    async (batch) => {
      calls.push(batch);
      if (batch.length === 4) throw tooLarge;
      if (batch[0] === 3) throw denied;
      return batch;
    },
    exceedsBudget,
  );

  await expect(result).rejects.toBe(denied);
  expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
});

test("a rejected singleton can use an explicit fallback without retrying it", async () => {
  const read = async (_batch: number[]): Promise<string[]> => {
    throw tooLarge;
  };
  await expect(splitBatchOn([1], read, exceedsBudget)).rejects.toBe(tooLarge);

  const calls: number[] = [];
  const result = await splitBatchOn([1], read, exceedsBudget, async (item) => {
    calls.push(item);
    return String(item);
  });

  expect(calls).toEqual([1]);
  expect(result).toEqual(["1"]);
});
