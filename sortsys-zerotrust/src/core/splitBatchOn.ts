/** Split only a rejected batch. Keep input order and publish no partial result. */
export async function splitBatchOn<T, R>(
  input: T[],
  read: (input: T[]) => Promise<R[]>,
  maySplit: (error: unknown) => boolean,
  readSingle?: (item: T) => Promise<R>,
): Promise<R[]> {
  async function attempt(batch: T[]): Promise<R[]> {
    try {
      return await read(batch);
    } catch (error) {
      if (!maySplit(error)) throw error;

      if (batch.length === 1 && readSingle) {
        return [await readSingle(batch[0]!)];
      }
      if (batch.length < 2) throw error;

      const middle = Math.ceil(batch.length / 2);
      const first = await attempt(batch.slice(0, middle));
      const last = await attempt(batch.slice(middle));
      return [...first, ...last];
    }
  }

  return attempt(input);
}
