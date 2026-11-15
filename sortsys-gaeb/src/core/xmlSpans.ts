import type { XmlElement } from "libxml2-wasm";

const MAX_NODES = 150000;
const MAX_DEPTH = 256;
const invalid = () => new Error("invalid-gaeb-xml-spans");

/** Pair validated elements with their original UTF-16 spans. This preserves
 * unknown XML, namespaces, comments and whitespace when one field is edited. */
export type GaebXmlElementSpan = {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  name: string;
  ordinal: number;
  element: XmlElement;
  children: GaebXmlElementSpan[];
};
export function gaebXmlElementSpans(
  source: string,
  elements: XmlElement[],
): GaebXmlElementSpan[] {
  const roots: GaebXmlElementSpan[] = [];
  const stack: GaebXmlElementSpan[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')+>/g;
  const ordinals = new Map<
    GaebXmlElementSpan | undefined,
    Map<string, number>
  >();
  let count = 0;
  for (const token of source.matchAll(tokens)) {
    const raw = token[0];
    const start = token.index!;
    const end = start + raw.length;
    if (raw.startsWith("<!") || raw.startsWith("<?")) continue;
    if (raw.startsWith("</")) {
      const node = stack.pop();
      if (!node || raw.slice(2).replace(/\s*>$/, "") !== node.name)
        throw invalid();
      node.closeStart = start;
      node.end = end;
      continue;
    }
    const name = /^<([^\s/>]+)/.exec(raw)?.[1];
    const element = elements[count++];
    if (
      !name ||
      !element ||
      name.split(":").at(-1) !== element.name ||
      stack.length > MAX_DEPTH ||
      count > MAX_NODES
    )
      throw invalid();
    const siblings = ordinals.get(stack.at(-1)) ?? new Map<string, number>();
    const identity = `${element.namespaceUri}:${element.name}`;
    const ordinal = siblings.get(identity) ?? 0;
    siblings.set(identity, ordinal + 1);
    ordinals.set(stack.at(-1), siblings);
    const node: GaebXmlElementSpan = {
      start,
      openEnd: end,
      closeStart: end,
      end,
      name,
      ordinal,
      element,
      children: [],
    };
    (stack.at(-1)?.children ?? roots).push(node);
    if (!/\/\s*>$/.test(raw)) stack.push(node);
  }
  if (stack.length || count !== elements.length || roots.length !== 1)
    throw invalid();
  return roots;
}
