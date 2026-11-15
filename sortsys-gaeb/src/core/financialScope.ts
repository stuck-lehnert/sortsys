import { XmlElement } from "libxml2-wasm";
import { parseFinancialSource } from "./financialView";

/** Only structure and flags that can affect the supported arithmetic. Editing
 * a description must not invalidate prices in a protected content part. */
export function financialScopeStructure(source: string): string {
  const document = parseFinancialSource(source);
  const namespace = document.root.namespaceUri;
  function children(parent: XmlElement, name: string) {
    return parent
      .find("./*")
      .filter(
        (node): node is XmlElement =>
          node instanceof XmlElement &&
          node.namespaceUri === namespace &&
          node.name === name,
      );
  }
  function child(parent: XmlElement, name: string) {
    const found = children(parent, name);
    if (found.length > 1) {
      throw new Error("financial-view-structure");
    }
    return found[0];
  }
  function entry(node: XmlElement): unknown {
    const flags = [
      "Provis",
      "ProvisAccpt",
      "LumpSumItem",
      "NotAppl",
      "NotApplBoQ",
    ].map((name) => [name, child(node, name)?.content.trim() ?? null]);
    const body = child(node, "BoQBody");
    const nested: unknown[] = [];
    if (body) {
      for (const value of body.find("./*")) {
        if (
          !(value instanceof XmlElement) ||
          value.namespaceUri !== namespace
        ) {
          continue;
        }
        if (value.name === "BoQCtgy") {
          nested.push(entry(value));
        } else if (value.name === "Itemlist") {
          nested.push(...children(value, "Item").map(entry));
        }
      }
    }
    if (node.name === "Order") {
      nested.push(...children(node, "OrderItem").map(entry));
    }
    return {
      kind: node.name,
      id: node.attr("ID")?.value ?? null,
      number: node.attr("RNoPart")?.value ??
        child(node, "OrderPosNo")?.content.trim() ??
        null,
      index: node.attr("RNoIndex")?.value ?? null,
      flags,
      nested,
    };
  }
  try {
    const envelopes = ["Award", "Order", "Invoice"].flatMap((name) =>
      children(document.root, name)
    );
    if (envelopes.length !== 1) {
      throw new Error("financial-view-structure");
    }
    const envelope = envelopes[0]!;
    const boq = child(envelope, "BoQ");
    return JSON.stringify(entry(boq ?? envelope));
  } finally {
    document.dispose();
  }
}
