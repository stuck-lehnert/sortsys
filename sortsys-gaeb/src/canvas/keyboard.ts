export type TextDirection = -1 | 1;
export type TextRange = {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};
export function selectionEnds(range: TextRange) {
  return range.direction === "backward"
    ? { anchor: range.end, focus: range.start }
    : { anchor: range.start, focus: range.end };
}
export function extendSelection(
  range: TextRange,
  offset: number,
  extend: boolean,
): TextRange {
  const anchor = extend ? selectionEnds(range).anchor : offset;
  return {
    start: Math.min(anchor, offset),
    end: Math.max(anchor, offset),
    direction: offset < anchor ? "backward" : "forward",
  };
}
export function graphemeBoundary(
  value: string,
  offset: number,
  direction: TextDirection,
) {
  const boundaries = [
    0,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (segment) => segment.index + segment.segment.length,
    ),
  ];
  return direction < 0
    ? (boundaries.filter((point) => point < offset).at(-1) ?? 0)
    : (boundaries.find((point) => point > offset) ?? value.length);
}
export function wordBoundary(
  value: string,
  offset: number,
  direction: TextDirection,
  mac = false,
) {
  const words = [
    ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(value),
  ].filter((segment) => segment.isWordLike);
  if (direction < 0)
    return words.filter((word) => word.index < offset).at(-1)?.index ?? 0;
  const index = words.findIndex(
    (word) => word.index + word.segment.length > offset,
  );
  if (index < 0) return value.length;
  const word = words[index];
  return mac
    ? word.index + word.segment.length
    : word.index > offset
      ? word.index
      : (words[index + 1]?.index ?? value.length);
}
export function paragraphBoundary(
  value: string,
  offset: number,
  direction: TextDirection,
  mac = false,
) {
  if (direction < 0) {
    if (offset === 0) return 0;
    const start = value.lastIndexOf("\n", Math.max(-1, offset - 1)) + 1;
    return start === offset && start > 0
      ? start < 2
        ? 0
        : value.lastIndexOf("\n", start - 2) + 1
      : start;
  }
  const end = value.indexOf("\n", offset);
  if (end < 0) return value.length;
  if (!mac) return end + 1;
  if (end === offset) {
    const next = value.indexOf("\n", offset + 1);
    return next < 0 ? value.length : next;
  }
  return end;
}
export function macKeyboard() {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}
