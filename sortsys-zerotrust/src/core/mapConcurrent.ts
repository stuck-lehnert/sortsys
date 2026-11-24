/** Bound independent operations and preserve their input order. On failure,
 * wait for every started operation before the caller closes shared resources. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Invalid concurrency limit");
  }

  const results = new Array<R>(values.length);
  let next = 0;
  let failure: { reason: unknown } | undefined;

  async function worker(): Promise<void> {
    while (!failure && next < values.length) {
      const index = next++;
      try {
        results[index] = await run(values[index]!, index);
      } catch (error) {
        failure ??= { reason: error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    worker,
  );
  await Promise.all(workers);

  if (failure) throw failure.reason;
  return results;
}
