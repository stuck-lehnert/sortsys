import type { ReactNode } from "react";
import type { DocumentExcerpt as Excerpt } from "../lib/search/documentQuery";

export function DocumentExcerpt({ value }: { value: Excerpt }) {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const range of value.highlights) {
    parts.push(value.text.slice(offset, range.start));
    parts.push(
      <mark key={range.start}>{value.text.slice(range.start, range.end)}</mark>,
    );
    offset = range.end;
  }
  parts.push(value.text.slice(offset));
  return <>{parts}</>;
}
