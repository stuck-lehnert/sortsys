import type { GaebDocument, GaebEntry } from "./document";
import {
  gaebAmountFacet,
  gaebElementFacet,
  gaebQuantityFacet,
  type GaebContentFacet,
} from "./contentFacets";

type MetadataField = { key: string; element: Element; index: number };
const metadataSnapshots = new WeakMap<
  GaebDocument,
  Map<string, MetadataField>
>();
const entrySnapshots = new WeakMap<GaebDocument, Map<string, GaebEntry>>();

/** Resolve from the longest matching key without rescanning the complete LV
 * for every field or untrusted candidate name. Snapshots share this index. */
export function entryForField(
  model: GaebDocument,
  key: string,
): GaebEntry | undefined {
  let entries = entrySnapshots.get(model);
  if (!entries) {
    entries = new Map(model.entries.map((entry) => [entry.key, entry]));
    entrySnapshots.set(model, entries);
  }
  let separator = key.lastIndexOf(":");
  while (separator > 0) {
    const entry = entries.get(key.slice(0, separator));
    if (entry) {
      return entry;
    }
    separator = key.lastIndexOf(":", separator - 1);
  }
  return undefined;
}

/** Sibling positions count only equal expanded names. Removing an encrypted
 * InvoiceHeader, for example, cannot renumber a later recipient address. */
export function metadataFieldKey(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    let ordinal = 0;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (
        sibling.localName === current.localName &&
        sibling.namespaceURI === current.namespaceURI
      ) {
        ordinal += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    const namespace = encodeURIComponent(current.namespaceURI ?? "");
    const name = encodeURIComponent(current.localName);
    segments.push(`${namespace}|${name}[${ordinal}]`);
    current = current.parentElement;
  }
  const key = `meta:${segments.reverse().join("/")}`;
  if (key.length > 4096) {
    throw new Error("invalid-field");
  }
  return key;
}

export function metadataFields(
  model: GaebDocument,
): ReadonlyMap<string, MetadataField> {
  let fields = metadataSnapshots.get(model);
  if (!fields) {
    fields = new Map();
    for (const [index, element] of model.metadataElements().entries()) {
      const key = metadataFieldKey(element);
      if (fields.has(key)) {
        throw new Error("invalid-field");
      }
      fields.set(key, { key, element, index });
    }
    metadataSnapshots.set(model, fields);
  }
  return fields;
}

export function metadataField(
  model: GaebDocument,
  key: string,
): MetadataField | undefined {
  return metadataFields(model).get(key);
}

/** Follow the same inherited ownership and opaque-subtree boundary as the
 * native XML partitioner. A recognized leaf inside a vendor node stays opaque. */
export function elementContentFacet(
  model: GaebDocument,
  element: Element,
  kind = model.documentKind ?? "",
): GaebContentFacet {
  const path: Element[] = [];
  let current: Element | null = element;
  while (current) {
    path.push(current);
    if (current === model.root) {
      break;
    }
    current = current.parentElement;
  }
  if (path.at(-1) !== model.root) {
    throw new Error("invalid-field");
  }
  let owner: GaebContentFacet = "scope";
  for (const node of path.reverse()) {
    owner = gaebElementFacet(
      node.localName,
      node.namespaceURI === model.namespace,
      node.parentElement?.localName,
      owner,
      kind,
      model.phase,
    );
    if (owner === "opaque") {
      return owner;
    }
  }
  return owner;
}

function metadataKeyFacet(
  model: GaebDocument,
  key: string,
  kind: string,
): GaebContentFacet | undefined {
  let owner: GaebContentFacet = "scope";
  let parent: string | undefined;
  const parts = key.slice(5).split("/");
  for (const [index, part] of parts.entries()) {
    const match = /^([^|]*)\|([^[]+)\[(0|[1-9]\d*)\]$/.exec(part);
    if (!match) {
      return undefined;
    }
    let namespace: string;
    let name: string;
    try {
      namespace = decodeURIComponent(match[1]!);
      name = decodeURIComponent(match[2]!);
    } catch {
      return undefined;
    }
    if (
      encodeURIComponent(namespace) !== match[1] ||
      encodeURIComponent(name) !== match[2]
    ) {
      return undefined;
    }
    if (
      index === 0 &&
      (namespace !== model.namespace || name !== "GAEB" || match[3] !== "0")
    ) {
      return undefined;
    }
    owner = gaebElementFacet(
      name,
      namespace === model.namespace,
      parent,
      owner,
      kind,
      model.phase,
    );
    if (owner === "opaque") {
      return owner;
    }
    parent = name;
  }
  return owner;
}

/** Resolve ownership before the canvas registers a field. In particular, a
 * scope packet cannot reserve a known invoice field during initial loading. */
export function nativeFieldFacet(
  model: GaebDocument,
  key: string,
  kind = model.documentKind ?? "",
): GaebContentFacet | undefined {
  if (["project:title", "document:title", "takeoff:title"].includes(key)) {
    return "scope";
  }
  if (key.startsWith("meta:")) {
    const field = metadataField(model, key);
    if (field) {
      return elementContentFacet(model, field.element, kind);
    }
    return metadataKeyFacet(model, key, kind);
  }
  if (key.endsWith(":Qty")) {
    return gaebQuantityFacet(model.phase);
  }
  if (key.endsWith(":UP")) {
    return gaebAmountFacet(kind, model.phase);
  }
  if (key.endsWith(":QU")) {
    return "scope";
  }
  const entry = entryForField(model, key);
  if (!entry) {
    return undefined;
  }
  const name = key.slice(entry.key.length + 1);
  if (name === "Qty") {
    return gaebQuantityFacet(model.phase);
  }
  if (name === "UP") {
    return gaebAmountFacet(kind, model.phase);
  }
  if (name === "QU") {
    return "scope";
  }
  if (name.startsWith("measure:") || name.startsWith("heading:")) {
    return "measurement";
  }
  const text = /^text:(0|[1-9]\d*)$/.exec(name);
  if (text) {
    const group = model.richGroups(entry)[Number(text[1])];
    const element = group?.nodes[0];
    return element ? elementContentFacet(model, element, kind) : undefined;
  }
  return undefined;
}
