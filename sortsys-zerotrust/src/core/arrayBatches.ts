/** Yield consecutive nonempty slices without copying the remaining input. */
export function* arrayBatches<T>(items: readonly T[], size: number) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError("Batch size must be a positive safe integer");
  }

  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}
