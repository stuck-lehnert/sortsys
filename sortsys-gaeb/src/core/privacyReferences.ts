import type {
  GaebXmlFragment,
  GaebXmlLayout,
  GaebXmlNode,
  GaebXmlRef,
  GaebXmlText,
} from "./privacy";

const invalid = () => new Error("invalid-gaeb-partition");

export function gaebStructuralId(path: string): string {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length > 6000) {
    throw invalid();
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `p${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function referencePath(id: string) {
  const base64 = id.slice(1).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (gaebStructuralId(path) !== id) {
    throw invalid();
  }
  return path;
}

function referenceParent(reference: GaebXmlRef) {
  const path = referencePath(reference.id);
  if (reference.surface === "element") {
    const suffix = `/element:${reference.facet}`;
    if (!path.endsWith(suffix)) {
      throw invalid();
    }
    const node = path.slice(0, -suffix.length);
    const separator = node.lastIndexOf("/");
    if (separator < 0 || !/^[^/]+\[\d+\]$/.test(node.slice(separator + 1))) {
      throw invalid();
    }
    return node.slice(0, separator);
  }
  const separator = path.lastIndexOf("/");
  const segment = path.slice(separator + 1);
  const prefix = reference.surface === "attribute" ? "attribute:" : "content:";
  if (
    separator < 0 ||
    !segment.startsWith(prefix) ||
    !/^\d+$/.test(segment.slice(prefix.length))
  ) {
    throw invalid();
  }
  return path.slice(0, separator);
}

export function sealedGaebReference(reference: GaebXmlRef): string {
  if (reference.surface === "attribute") {
    return ` data-sortsys-sealed-${reference.id}=""`;
  }
  return `<!--sortsys:sealed:${encodeURIComponent(reference.id).replaceAll("-", "%2D")}-->`;
}

type RetainedReference = {
  reference: GaebXmlRef;
  parent: string;
  order: number;
};

/** A partial XML view may carry existing private references, but cannot forge,
 * duplicate, reassign or selectively delete them inside an existing element. */
export class GaebViewReferences {
  readonly signed: boolean;
  private references = new Map<string, RetainedReference>();
  private consumed = new Set<string>();
  private elements = new Set<string>();
  private lastOrder = new Map<string, number>();
  private publicShells = new Map<
    string,
    Extract<GaebXmlNode, { type: "element" }>
  >();

  constructor(layout: GaebXmlLayout, fragments: readonly GaebXmlFragment[]) {
    this.signed = layout.signed;
    const visible = new Set(fragments.map((fragment) => fragment.id));
    const collectValue = (value: GaebXmlText, parent: string) => {
      if (typeof value === "string" || visible.has(value.id)) {
        return;
      }
      if (referenceParent(value) !== parent) {
        throw invalid();
      }
      if (this.references.has(value.id)) {
        throw invalid();
      }
      this.references.set(value.id, {
        reference: { ...value },
        parent,
        order: this.references.size,
      });
    };
    const collectNode = (node: GaebXmlNode, parent: string) => {
      if (node.type === "raw") {
        collectValue(node.value, parent);
        return;
      }
      if (node.owner === "scope") {
        this.publicShells.set(node.key, node);
      }
      for (const value of node.open) {
        collectValue(value, node.key);
      }
      for (const child of node.children) {
        collectNode(child, node.key);
      }
    };
    for (const node of layout.nodes) {
      collectNode(node, "document");
    }
    for (const fragment of fragments) {
      if (typeof fragment.content !== "string") {
        collectNode(fragment.content, "document");
      }
    }
  }
  has(id: string) {
    return this.references.has(id);
  }
  /** Filling an optional private field may expand <Item/>. Preserve the public
   * shell spelling; the renderer expands it only while it has visible children. */
  preservePublicShell(node: Extract<GaebXmlNode, { type: "element" }>) {
    const previous = this.publicShells.get(node.key);
    if (!previous || (previous.close !== null && node.close !== null)) {
      return node;
    }
    function expandedShell(value: typeof node) {
      const open = [...value.open];
      const last = open.at(-1);
      const first = open[0];
      if (typeof first !== "string" || typeof last !== "string") {
        return null;
      }
      const name = /^<([^\s/>]+)/.exec(first)?.[1];
      if (!name) {
        return null;
      }
      if (value.close === null) {
        open[open.length - 1] = last.replace(/\/\s*>$/, ">");
      }
      return { open, close: value.close ?? `</${name}>` };
    }
    const oldShell = expandedShell(previous);
    const newShell = expandedShell(node);
    if (oldShell && JSON.stringify(oldShell) === JSON.stringify(newShell)) {
      return { ...node, open: previous.open, close: previous.close };
    }
    return node;
  }
  element(key: string) {
    if (this.elements.has(key)) {
      throw invalid();
    }
    this.elements.add(key);
  }
  consume(id: string, parent: string, attribute: boolean): GaebXmlRef {
    const retained = this.references.get(id);
    if (
      !retained ||
      retained.parent !== parent ||
      this.consumed.has(id) ||
      (retained.reference.surface === "attribute") !== attribute
    ) {
      throw invalid();
    }
    const group = `${parent}:${attribute ? "attributes" : "content"}`;
    if (retained.order <= (this.lastOrder.get(group) ?? -1)) {
      throw invalid();
    }
    this.lastOrder.set(group, retained.order);
    this.consumed.add(id);
    return { ...retained.reference };
  }
  finish() {
    for (const [id, retained] of this.references) {
      if (
        !this.consumed.has(id) &&
        (retained.parent === "document" || this.elements.has(retained.parent))
      ) {
        throw invalid();
      }
    }
  }
}
