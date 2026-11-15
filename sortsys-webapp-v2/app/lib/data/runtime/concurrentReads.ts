/** Bound independent reads and preserve their input order. On failure, wait
 * for every started read before the caller closes its shared resources. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  read: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Invalid concurrent read limit");
  }
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed && next < values.length) {
      const index = next++;
      try {
        results[index] = await read(values[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    worker,
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}
