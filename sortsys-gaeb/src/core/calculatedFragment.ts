import type { GaebXmlFragment, GaebXmlNode } from "./privacy";

function nameOf(key: string): string | undefined {
  return (
    /(?:^|\/)([^/\[]+)\[\d+\]$/.exec(key)?.[1] ?? /^@([^:]+):/.exec(key)?.[1]
  );
}

function derivedScalar(
  name: string | undefined,
  parent: string | undefined,
  percentageDiscount: boolean,
) {
  if (name === "IT" && parent === "Item") {
    return true;
  }
  if (parent !== "Totals") {
    return false;
  }
  if (name === "DiscountAmt") {
    return percentageDiscount;
  }
  return (
    name !== undefined &&
    ["Total", "TotAfterDisc", "TotalNet", "VATAmount", "TotalGross"].includes(
      name,
    )
  );
}

/** Compare protected inputs independently of their automatically derived text.
 * The stored fragment itself is retained, so this grants no price mutation. */
export function withoutCalculatedValues(
  fragment: GaebXmlFragment,
): GaebXmlFragment {
  if (typeof fragment.content === "string") {
    return fragment;
  }
  function visit(
    node: GaebXmlNode,
    parent?: string,
    percentageDiscount = false,
  ): GaebXmlNode {
    if (node.type === "raw") {
      return node;
    }
    const name = nameOf(node.key);
    if (derivedScalar(name, parent, percentageDiscount)) {
      const protectedChildren = node.children.filter(
        (child) => child.type !== "raw" || typeof child.value !== "string",
      );
      return {
        ...node,
        children: [{ type: "raw", value: "0.00" }, ...protectedChildren],
      };
    }
    const hasPercentageDiscount = node.children.some(
      (child) =>
        child.type === "element" && nameOf(child.key) === "DiscountPcnt",
    );
    return {
      ...node,
      children: node.children.map((child) =>
        visit(child, name, hasPercentageDiscount)
      ),
    };
  }
  const parentPath = fragment.content.type === "element"
    ? fragment.content.key.slice(0, fragment.content.key.lastIndexOf("/"))
    : "";
  return { ...fragment, content: visit(fragment.content, nameOf(parentPath)) };
}
