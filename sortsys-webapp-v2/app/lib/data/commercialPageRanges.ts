export const COMMERCIAL_PAGE_LIMIT = 200;

/** Request one contiguous window whenever it fits in the overview query. */
export function commercialPageRanges(rows: number) {
  const ranges = [];

  for (let offset = 0; offset < rows; offset += COMMERCIAL_PAGE_LIMIT) {
    ranges.push({
      offset: BigInt(offset),
      limit: BigInt(Math.min(rows - offset, COMMERCIAL_PAGE_LIMIT)),
    });
  }

  return ranges;
}
