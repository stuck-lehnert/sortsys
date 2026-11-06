export type RichTextGroup = {
  nodes: Element[];
  paragraphs: boolean;
  text: string;
  leaves: Array<{
    element: Element;
    index: number;
    start: number;
    end: number;
  }>;
};

/** Adjacent ordinary paragraphs form one text buffer; table cells, list items and
 * protected structured text retain their own boundaries and original XML. */
export function richTextGroups(
  roots: Element[],
  leaves: Element[],
  namespace: string,
): RichTextGroup[] {
  const indices = new Map(leaves.map((element, index) => [element, index]));
  const simple = (element: Element) =>
    element.namespaceURI === namespace &&
    element.localName === "p" &&
    [...element.childNodes].every(
      (node) =>
        node.nodeType === 1 ||
        node.nodeType === 8 ||
        ((node.nodeType === 3 || node.nodeType === 4) &&
          !node.textContent?.trim()),
    ) &&
    element.children.length > 0 &&
    [...element.children].every(
      (child) =>
        child.namespaceURI === namespace &&
        child.localName === "span" &&
        !child.children.length &&
        [...child.childNodes].every(
          (node) => node.nodeType === 3 || node.nodeType === 4,
        ),
    );
  const groups: RichTextGroup[] = [];
  for (const root of roots)
    for (const element of [
      root,
      ...root.getElementsByTagNameNS(namespace, "*"),
    ]) {
      const paragraph = simple(element);
      if (
        !paragraph &&
        (!indices.has(element) || simple(element.parentElement!))
      )
        continue;
      const previous = groups.at(-1);
      const append =
        paragraph &&
        previous?.paragraphs &&
        previous.nodes.at(-1)?.parentElement === element.parentElement &&
        previous.nodes.at(-1)?.nextElementSibling === element;
      const group = append
        ? previous!
        : { nodes: [], paragraphs: paragraph, text: "", leaves: [] };
      if (append) group.text += "\n";
      else groups.push(group);
      group.nodes.push(element);
      const members = paragraph ? [...element.children] : [element];
      for (const leaf of members) {
        const start = group.text.length;
        group.text += leaf.textContent ?? "";
        group.leaves.push({
          element: leaf,
          index: indices.get(leaf)!,
          start,
          end: group.text.length,
        });
      }
    }
  return groups;
}

export function textDifference(before: string, after: string) {
  let from = 0;
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from++;
  let to = before.length,
    end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}

/** Older recovery records stored one draft per span. Do not interpret such a
 * draft as a replacement for the newly combined paragraph buffer. */
export function migrateRichDrafts(
  model: import("./document").GaebDocument,
  drafts: Array<[string, string]>,
): Array<[string, string]> {
  const result = new Map(drafts.filter(([key]) => !/:rich:\d+$/.test(key)));
  const pending = new Map<
    string,
    { text: string; edits: Array<{ from: number; to: number; value: string }> }
  >();
  for (const [key, value] of drafts) {
    const match = /^(.*):rich:(\d+)$/.exec(key);
    if (!match) continue;
    const entry = model.entries.find((entry) => entry.key === match[1]);
    const groups = entry ? model.richGroups(entry) : [];
    const index = groups.findIndex((group) =>
      group.leaves.some((leaf) => leaf.index === Number(match[2])),
    );
    if (index < 0) throw new Error("merge-conflict");
    const group = groups[index],
      leaf = group.leaves.find((leaf) => leaf.index === Number(match[2]))!;
    const target = `${entry!.key}:text:${index}`;
    if (result.has(target)) continue;
    const record = pending.get(target) ?? { text: group.text, edits: [] };
    record.edits.push({ from: leaf.start, to: leaf.end, value });
    pending.set(target, record);
  }
  for (const [key, record] of pending) {
    let value = record.text;
    for (const edit of record.edits.sort((a, b) => b.from - a.from))
      value = value.slice(0, edit.from) + edit.value + value.slice(edit.to);
    result.set(key, value);
  }
  return [...result];
}
