import { nativeScalarPatch } from "./scalarTextPatch";
import { type XmlDocument, XmlElement } from "libxml2-wasm";
import { type GaebXmlElementSpan, gaebXmlElementSpans } from "./xmlSpans";

type Owner = "item" | "category" | "boq";

export function calculatedValueKey(
  owner: Owner,
  position: string[],
  field: string,
) {
  return JSON.stringify([owner, position, field]);
}

export function applyCalculatedValues(
  source: string,
  document: XmlDocument,
  values: ReadonlyMap<string, string>,
): string {
  const elements = document
    .find("//*")
    .filter((node): node is XmlElement => node instanceof XmlElement);
  const root = gaebXmlElementSpans(source, elements)[0]!;
  const namespace = document.root.namespaceUri;
  const edits: { start: number; end: number; value: string }[] = [];

  function child(parent: GaebXmlElementSpan | undefined, name: string) {
    return parent?.children.find(
      (node) =>
        node.element.namespaceUri === namespace && node.element.name === name,
    );
  }
  function patch(
    parent: GaebXmlElementSpan,
    owner: Owner,
    position: string[],
    prefix = "",
  ) {
    for (const field of parent.children) {
      if (field.element.namespaceUri !== namespace) {
        continue;
      }
      const key = calculatedValueKey(
        owner,
        position,
        prefix + field.element.name,
      );
      const value = values.get(key);
      if (value !== undefined) {
        edits.push(nativeScalarPatch(source, field, value));
      }
    }
  }
  function visit(owner: GaebXmlElementSpan, position: string[], top = false) {
    const body = child(owner, "BoQBody");
    if (!body) {
      return;
    }
    const items = child(body, "Itemlist");
    for (const item of items?.children ?? []) {
      if (
        item.element.namespaceUri !== namespace ||
        item.element.name !== "Item"
      ) {
        continue;
      }
      const itemPosition = [
        ...position,
        item.element.attr("RNoPart")?.value ?? "",
        item.element.attr("RNoIndex")?.value ?? "",
      ];
      patch(item, "item", itemPosition);
    }
    for (const category of body.children) {
      if (
        category.element.namespaceUri !== namespace ||
        category.element.name !== "BoQCtgy"
      ) {
        continue;
      }
      visit(category, [
        ...position,
        category.element.attr("RNoPart")?.value ?? "",
      ]);
    }
    const totals = top
      ? child(child(owner, "BoQInfo"), "Totals")
      : child(owner, "Totals");
    if (totals) {
      patch(totals, top ? "boq" : "category", position, "Totals/");
    }
  }
  const envelope = root.children.find(
    (node) =>
      node.element.namespaceUri === namespace &&
      ["Award", "Invoice", "Order"].includes(node.element.name),
  );
  const boq = child(envelope, "BoQ");
  if (boq) {
    visit(boq, [], true);
  }
  edits.sort((left, right) => right.start - left.start);
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}
