import { GaebDocument, type GaebEntry } from "./document";
import { createGaebXml } from "./templates";
import { phaseHasPrices, isTradePhase, type GaebPhase } from "./types";
import { decimal, decimalString, itemAmount, roundedDivide } from "./decimal";

export type DerivationOptions = {
  referenceXml?: string;
  pricesXml?: string;
  selectedItemIds?: string[];
  ownCompany?: string;
  ownAddress?: {
    streetAddress: string;
    zip?: string | null;
    city: string;
    country?: string | null;
  } | null;
  partnerName?: string;
  title?: string;
  projectTitle?: string;
  documentKind?: string;
};
const idOf = (entry: GaebEntry) => entry.element.getAttribute("ID") ?? entry.oz;
function matching(doc: GaebDocument | undefined, entry: GaebEntry) {
  return (
    doc?.items.find((candidate) => idOf(candidate) === idOf(entry)) ??
    doc?.items.find((candidate) => candidate.oz === entry.oz)
  );
}

/** Create the next native file in a business document chain. The host retains
 * the unmodified source and links its exact revision. Native XML remains the
 * authoritative document; unsupported pricing rules stop derivation. */
export function deriveGaebDocument(
  xml: string,
  phase: GaebPhase,
  options: DerivationOptions = {},
): string {
  const source = new GaebDocument(xml, "source.xml");
  if (isTradePhase(phase)) return deriveTradeDocument(source, phase, options);
  const reference = options.referenceXml
    ? new GaebDocument(options.referenceXml, "reference.xml")
    : undefined;
  for (const doc of [source, reference]) {
    if (!doc) continue;
    const award = doc.child(doc.root, "Award");
    const info = award && doc.child(award, "AwardInfo");
    const currency = info && doc.value(info, "Cur");
    if (currency && currency !== "EUR") throw new Error("workflow-currency");
  }
  const scope = source.phase === "84" ? reference : source;
  if (!scope) throw new Error("workflow-reference-required");
  if (phase === "87" && source.phase === "86") {
    // A confirmation retains the complete accepted scope, pricing rules and
    // parties from the order, including opaque extensions in its own namespace.
    if (source.signed) throw new Error("workflow-pricing-rules");
    const targetNamespace = source.namespace.replace("DA86", "DA87");
    const output = document.implementation.createDocument(null, null);
    const rephase = (node: Node): Node => {
      if (node.nodeType !== 1) return output.importNode(node, true);
      const original = node as Element;
      const element = output.createElementNS(
        original.namespaceURI === source.namespace
          ? targetNamespace
          : original.namespaceURI,
        original.tagName,
      );
      for (const attr of original.attributes) {
        if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) {
          element.setAttributeNS(
            attr.namespaceURI,
            attr.name,
            attr.value === source.namespace ? targetNamespace : attr.value,
          );
        } else element.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      }
      for (const child of original.childNodes) element.append(rephase(child));
      if (
        original.namespaceURI === source.namespace &&
        original.localName === "DP"
      )
        element.textContent = "87";
      return element;
    };
    output.append(rephase(source.root));
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(output.documentElement) +
      "\n"
    );
  }
  // A newly projected pricing file cannot silently discard rules that are not
  // represented in X84. Keep those originals viewable and stop this derivation.
  const specialized = [
    "Provis",
    "ProvisAccpt",
    "LumpSumItem",
    "NotAppl",
    "NotApplBoQ",
    "ALNSerNo",
    "CONo",
    "COStatus",
    "RefBaseItem",
    "QtyTBD",
    "UPBkdn",
    "SubDescr",
    "Product",
    "RefDescr",
    "RefRNo",
    "RefPerfNo",
  ];
  if (
    phase !== "31" &&
    [scope, source].some(
      (doc) =>
        doc.hasComplexPricing() ||
        specialized.some(
          (name) =>
            doc.xml.getElementsByTagNameNS(doc.namespace, name).length > 0,
        ) ||
        [...doc.xml.getElementsByTagNameNS(doc.namespace, "Totals")].some(
          (total) =>
            ["DiscountPcnt", "DiscountAmt", "VAT"].some(
              (name) => !!doc.value(total, name),
            ),
        ),
    )
  )
    throw new Error("workflow-pricing-rules");
  const prices = options.pricesXml
    ? new GaebDocument(options.pricesXml, "prices.xml")
    : source.phase === "84" ||
        source.phase === "85" ||
        source.phase === "86" ||
        source.phase === "87"
      ? source
      : undefined;
  const target = new GaebDocument(
    createGaebXml(phase, options.title ?? scope.title),
    `document.x${phase}`,
  );
  const result = target.xml;
  const kind = options.documentKind ?? source.documentKind;
  if (kind)
    target.root.append(
      result.createComment(
        `sortsys:document-kind:v1:${encodeURIComponent(kind)}`,
      ),
    );
  const ns = target.namespace;
  const create = (name: string, value?: string) => {
    const element = result.createElementNS(ns, name);
    if (value !== undefined) element.textContent = value;
    return element;
  };
  if (phase === "31") {
    const determination = target.child(target.root, "QtyDeterm")!;
    const projectName = options.projectTitle || scope.projectName();
    const prj = create("PrjInfo");
    prj.append(
      create("RefPrjName", Array.from(projectName).slice(0, 60).join("")),
    );
    if (projectName) determination.insertBefore(prj, determination.firstChild);
    const refName = target.xml.getElementsByTagNameNS(ns, "RefBoQName")[0];
    const boqInfo = scope.xml.getElementsByTagNameNS(
      scope.namespace,
      "BoQInfo",
    )[0];
    if (refName)
      refName.textContent = Array.from(
        scope.value(boqInfo, "Name") || scope.title,
      )
        .slice(0, 20)
        .join("");
  }
  const clone = (element: Element): Element => {
    if (
      element.namespaceURI !== scope.namespace &&
      element.namespaceURI !== prices?.namespace
    )
      return result.importNode(element, true);
    const copy = create(element.localName);
    for (const attr of element.attributes)
      if (
        attr.name !== "xmlns" &&
        !attr.name.startsWith("xmlns:") &&
        (phase !== "83" || !attr.namespaceURI)
      )
        copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    for (const node of element.childNodes) {
      if (phase === "83" && ![1, 3, 4].includes(node.nodeType)) continue;
      // A purchasing inquiry must never forward opaque vendor payloads, which
      // may contain our selling prices. The retained source stays untouched.
      if (
        phase === "83" &&
        node.nodeType === 1 &&
        (node as Element).namespaceURI !== scope.namespace &&
        (node as Element).namespaceURI !== prices?.namespace
      )
        continue;
      copy.append(
        node.nodeType === 1
          ? clone(node as Element)
          : result.importNode(node, true),
      );
    }
    return copy;
  };
  const sourceProject = scope.xml.getElementsByTagNameNS(
    scope.namespace,
    "PrjInfo",
  )[0];
  if (phase !== "31" && sourceProject) {
    // X84 carries only project identifiers. Currency and rich project metadata
    // stay in the unchanged request; the pricing file has its own AwardInfo.
    const project = phase === "84" ? create("PrjInfo") : clone(sourceProject);
    if (phase === "84") {
      for (const name of ["NamePrj", "PrjID", "LblPrj"]) {
        const original = scope.child(sourceProject, name);
        if (original) project.append(clone(original));
        else if (name === "NamePrj")
          project.append(create(name, scope.projectName().slice(0, 60)));
      }
    }
    target.root.insertBefore(project, target.root.children[1] ?? null);
  }
  const selected = new Set(options.selectedItemIds ?? scope.items.map(idOf));
  if (
    !selected.size ||
    [...selected].some((id) => !scope.items.some((entry) => idOf(entry) === id))
  )
    throw new Error("workflow-scope-required");
  const buildItem = (entry: GaebEntry): Element | null => {
    if (!selected.has(idOf(entry))) return null;
    // Updating our existing calculation must follow stable IDs. A newly inserted
    // position may have taken an old OZ; it must never inherit that item's price.
    const priced = options.pricesXml
      ? prices?.items.find((item) => idOf(item) === idOf(entry))
      : matching(prices, entry);
    if (["86", "87"].includes(phase) && !priced)
      throw new Error("workflow-missing-prices");
    if (
      source.phase === "84" &&
      phase === "86" &&
      priced &&
      prices &&
      prices.quantity(priced) &&
      decimal(prices.quantity(priced) || "0", 3) !==
        decimal(scope.quantity(entry) || "0", 3)
    )
      throw new Error("workflow-quantity-difference");
    if (
      ["86", "87"].includes(phase) &&
      priced &&
      prices?.value(priced.element, "NotOffered") === "Yes"
    )
      return null;
    const item = create("Item");
    for (const name of ["ID", "RNoPart", "RNoIndex"]) {
      const value = entry.element.getAttribute(name);
      if (value) item.setAttribute(name, value);
    }
    const quantity = scope.quantity(entry) || "0.000";
    const price =
      priced && prices
        ? prices.value(priced.element, "UP") || "0.000"
        : "0.000";
    if (phase === "31") {
      const takeoff = create("QtyDeterm");
      takeoff.append(create("Qty", "0.000"));
      item.append(takeoff);
      return item;
    }
    if (phase === "84" && priced && prices?.value(priced.element, "NotOffered"))
      item.append(create("NotOffered", "Yes"));
    item.append(create("Qty", quantity));
    if (phase !== "84")
      item.append(create("QU", scope.value(entry.element, "QU") || "St"));
    if (phase !== "83") {
      item.append(create("UP", price));
      if (priced && prices)
        for (const name of [
          "UPComp1",
          "UPComp2",
          "UPComp3",
          "UPComp4",
          "UPComp5",
          "UPComp6",
          "DiscountPcnt",
        ]) {
          const child = prices.child(priced.element, name);
          if (child) item.append(clone(child));
        }
      item.append(
        create(
          "IT",
          itemAmount(
            quantity,
            price,
            priced && prices
              ? prices.value(priced.element, "DiscountPcnt") || "0"
              : "0",
          ),
        ),
      );
    }
    if (phase !== "84") {
      const description = scope.child(entry.element, "Description");
      if (description) {
        if (scope.ownsPositionText(entry))
          item.append(result.createComment("sortsys:position-text"));
        item.append(clone(description));
      }
    }
    if (phase !== "83" && priced && prices)
      for (const comment of [...priced.element.children].filter(
        (child) =>
          child.localName === "BidComm" &&
          child.namespaceURI === prices.namespace,
      ))
        item.append(clone(comment));
    return item;
  };
  const buildBody = (body: Element): Element | null => {
    const built = create("BoQBody");
    for (const child of body.children) {
      if (child.namespaceURI !== scope.namespace) continue;
      if (child.localName === "BoQCtgy") {
        const originalBody = scope.child(child, "BoQBody");
        const content = originalBody && buildBody(originalBody);
        if (!content) continue;
        const category = create("BoQCtgy");
        for (const name of ["ID", "RNoPart"]) {
          const value = child.getAttribute(name);
          if (value) category.setAttribute(name, value);
        }
        if (!["84", "31"].includes(phase)) {
          const label = scope.child(child, "LblTx");
          if (label) category.append(clone(label));
        }
        category.append(content);
        if (["84", "85", "86", "87", "52"].includes(phase)) {
          const totals = create("Totals");
          totals.append(create("Total", "0.00"));
          category.append(totals);
        }
        built.append(category);
      } else if (child.localName === "Itemlist") {
        const list = create("Itemlist");
        for (const original of child.children) {
          const entry = scope.items.find((entry) => entry.element === original);
          if (entry) {
            const item = buildItem(entry);
            if (item) list.append(item);
          } else if (
            ["83", "86", "87"].includes(phase) &&
            original.localName === "Remark"
          )
            list.append(clone(original));
        }
        if ([...list.children].some((child) => child.localName === "Item"))
          built.append(list);
      }
    }
    return built.children.length ? built : null;
  };
  const originalBoQ = scope.xml.getElementsByTagNameNS(
    scope.namespace,
    "BoQ",
  )[0]!;
  const originalBody = scope.child(originalBoQ, "BoQBody");
  const body = originalBody && buildBody(originalBody);
  if (!body) throw new Error("workflow-scope-required");
  const boq = result.getElementsByTagNameNS(ns, "BoQ")[0]!;
  const id = originalBoQ.getAttribute("ID");
  if (id) boq.setAttribute("ID", id);
  const info = target.child(boq, "BoQInfo") ?? boq;
  const originalInfo = scope.child(originalBoQ, "BoQInfo") ?? originalBoQ;
  for (const breakdown of [...info.children].filter(
    (child) => child.localName === "BoQBkdn",
  ))
    breakdown.remove();
  for (const breakdown of [...originalInfo.children].filter(
    (child) => child.localName === "BoQBkdn",
  ))
    info.insertBefore(
      clone(breakdown),
      phase === "31" ? target.child(boq, "BoQBody") : null,
    );
  if (["84", "85", "86", "87", "52"].includes(phase)) {
    const totals = create("Totals");
    totals.append(create("Total", "0.00"));
    info.append(totals);
  }
  target.child(boq, "BoQBody")?.replaceWith(body);
  const award = target.child(target.root, "Award");
  const party = (name: string, company?: string, own = false) => {
    if (!award) return;
    // Updating a bid must retain its manually edited company/address and extensions.
    const previousAward = prices && prices.child(prices.root, "Award");
    const previous =
      own &&
      phase === "84" &&
      previousAward &&
      prices!.child(previousAward, name);
    let parent = target.child(award, name);
    if (previous) {
      const preserved = clone(previous);
      if (parent) parent.replaceWith(preserved);
      else
        award.insertBefore(
          preserved,
          name === "OWN" ? (target.child(award, "CTR") ?? boq) : boq,
        );
      return;
    }
    if (!company && !(own && options.ownAddress)) return;
    if (!parent) {
      parent = create(name);
      parent.append(create("Address"), create("CntryType", "EEA"));
      award.insertBefore(
        parent,
        name === "OWN" ? (target.child(award, "CTR") ?? boq) : boq,
      );
    }
    const address = target.child(parent, "Address")!;
    const addressData = own ? options.ownAddress : undefined;
    const nameParts = company
      ? Array.from(company).reduce<string[]>((parts, char, i) => {
          const index = Math.floor(i / 40);
          parts[index] = (parts[index] ?? "") + char;
          return parts;
        }, [])
      : [];
    if (nameParts.length > 4) throw new Error("workflow-address-length");
    const values: Array<[string, string | undefined | null, number]> = [
      ["Name1", nameParts[0], 40],
      ["Name2", nameParts[1], 40],
      ["Name3", nameParts[2], 40],
      ["Name4", nameParts[3], 40],
      ["Street", addressData?.streetAddress, 40],
      ["PCode", addressData ? (addressData.zip ?? "") : undefined, 20],
      ["City", addressData?.city, 40],
      ["Country", addressData?.country, 40],
    ];
    for (const [key, value, max] of values) {
      if (value && Array.from(value).length > max)
        throw new Error("workflow-address-length");
      const existing = target.child(address, key);
      if (value != null && (value !== "" || key === "PCode")) {
        if (existing) existing.textContent = value;
        else {
          const next = values
            .slice(values.findIndex(([field]) => field === key) + 1)
            .map(([field]) => target.child(address, field))
            .find(Boolean);
          address.insertBefore(create(key, value), next ?? null);
        }
      } else if (key.startsWith("Name") && key !== "Name1" && company)
        existing?.remove();
      else if (!existing && ["Name1", "Street", "PCode", "City"].includes(key))
        address.append(create(key, "…"));
    }
  };
  if (phase === "83" || phase === "86") {
    party("OWN", options.ownCompany, true);
    party("CTR", phase === "86" ? options.partnerName : undefined);
  } else {
    party("CTR", options.ownCompany, true);
    party("OWN", options.partnerName);
  }
  const currency = source.value(
    source.child(source.root, "Award") &&
      source.child(source.child(source.root, "Award"), "AwardInfo"),
    "Cur",
  );
  const targetAwardInfo = award && target.child(award, "AwardInfo");
  const cur = targetAwardInfo && target.child(targetAwardInfo, "Cur");
  if (cur && currency) cur.textContent = currency;
  const serialized =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(result.documentElement) +
    "\n";
  return new GaebDocument(serialized, `document.x${phase}`).recalculate();
}

export function gaebNetAmount(
  xml: string,
  referenceXml?: string,
): string | null {
  const doc = new GaebDocument(xml, "document.xml");
  if (!phaseHasPrices(doc.phase) || doc.hasComplexPricing()) return null;
  if (doc.phase === "89") {
    const invoice = doc.child(doc.root, "Invoice")!;
    const basic = [...invoice.children].find(
      (node) =>
        node.localName === "InvoiceShare" &&
        doc.value(node, "InvoiceShareType") === "basic amount",
    );
    if (!basic) return null;
    const deducted =
      doc.value(doc.child(invoice, "InvoiceHeader"), "InvoiceType") ===
      "final account"
        ? [...invoice.children]
            .filter((node) => node.localName === "InvoiceMadeOut")
            .reduce(
              (sum, node) => sum + decimal(doc.value(node, "Total") || "0", 2),
              0n,
            )
        : 0n;
    return decimalString(decimal(doc.value(basic, "Total"), 2) - deducted, 2);
  }
  if (isTradePhase(doc.phase))
    return decimalString(
      doc.items.reduce((sum, entry) => sum + decimal(doc.amount(entry), 2), 0n),
      2,
    );
  if (
    doc.signed ||
    (doc.phase === "84" && doc.items.some((item) => !doc.quantity(item)))
  ) {
    if (referenceXml)
      return gaebNetAmount(deriveGaebDocument(xml, "86", { referenceXml }));
    // X84 may omit quantities supplied by its X83. Never recalculate these as 0.
    const info = doc.xml.getElementsByTagNameNS(doc.namespace, "BoQInfo")[0];
    const totals = info && doc.child(info, "Totals");
    for (const name of ["TotAfterDisc", "TotalNet", "Total"]) {
      const value = doc.value(totals, name);
      if (value) return decimalString(decimal(value, 2), 2);
    }
    return null;
  }
  const computed = new GaebDocument(doc.recalculate(), doc.fileName);
  const info = computed.xml.getElementsByTagNameNS(
    computed.namespace,
    "BoQInfo",
  )[0];
  const totals = info && computed.child(info, "Totals");
  for (const name of ["TotAfterDisc", "TotalNet", "Total"]) {
    const value = computed.value(totals, name);
    if (value) return decimalString(decimal(value, 2), 2);
  }
  return decimalString(
    computed.items.reduce(
      (sum, entry) =>
        sum +
        decimal(
          itemAmount(
            computed.quantity(entry) || "0",
            computed.value(entry.element, "UP") || "0",
            computed.value(entry.element, "DiscountPcnt") || "0",
          ),
          2,
        ),
      0n,
    ),
    2,
  );
}
export type PositionDifference = {
  oz: string;
  change: "added" | "removed" | "quantity" | "price";
  before: string;
  after: string;
};
export function compareGaebPositions(
  before: string,
  after: string,
): PositionDifference[] {
  const first = new GaebDocument(before, "before.xml"),
    second = new GaebDocument(after, "after.xml");
  const differences: PositionDifference[] = [];
  for (const item of first.items) {
    const next = matching(second, item);
    if (!next) {
      differences.push({
        oz: item.oz,
        change: "removed",
        before: first.quantity(item),
        after: "",
      });
      continue;
    }
    for (const [change, left, right] of [
      ["quantity", first.quantity(item), second.quantity(next)],
      [
        "price",
        first.value(item.element, "UP"),
        second.value(next.element, "UP"),
      ],
    ] as const) {
      if (left && right && decimal(left, 3) !== decimal(right, 3))
        differences.push({ oz: item.oz, change, before: left, after: right });
    }
  }
  for (const item of second.items)
    if (!matching(first, item))
      differences.push({
        oz: item.oz,
        change: "added",
        before: "",
        after: second.quantity(item),
      });
  return differences;
}

/** Trade files stay native; procurement inquiries never disclose selling prices. */
function deriveTradeDocument(
  source: GaebDocument,
  phase: GaebPhase,
  options: DerivationOptions,
): string {
  if (source.signed) throw new Error("workflow-pricing-rules");
  const target = new GaebDocument(
    createGaebXml(phase, options.title ?? source.title),
    `document.x${phase}`,
  );
  const ns = target.namespace,
    output = target.xml;
  const kind = options.documentKind ?? source.documentKind;
  if (kind)
    target.root.append(
      output.createComment(
        `sortsys:document-kind:v1:${encodeURIComponent(kind)}`,
      ),
    );
  const el = (name: string, text?: string) => {
    const e = output.createElementNS(ns, name);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  let scopeNamespace = source.namespace;
  const clone = (node: Node): Node => {
    if (node.nodeType !== 1) return output.importNode(node, true);
    const original = node as Element;
    const copy = output.createElementNS(
      [source.namespace, scopeNamespace].includes(original.namespaceURI ?? "")
        ? ns
        : original.namespaceURI,
      original.tagName,
    );
    for (const attr of original.attributes)
      copy.setAttributeNS(
        attr.namespaceURI,
        attr.name,
        [source.namespace, scopeNamespace].includes(attr.value)
          ? ns
          : attr.value,
      );
    for (const child of original.childNodes) copy.append(clone(child));
    return copy;
  };
  const order = target.child(target.root, "Order")!;
  const projectSource = source.child(source.root, "PrjInfo");
  if (projectSource) target.root.insertBefore(clone(projectSource), order);
  if (isTradePhase(source.phase)) {
    for (const child of [...order.children])
      if (child.localName !== "DP") child.remove();
    const original = source.child(source.root, "Order")!;
    for (const child of original.childNodes) {
      if (child.nodeType === 1 && (child as Element).localName === "DP")
        continue;
      const node = clone(child);
      order.append(node);
      if (
        node.nodeType === 1 &&
        (node as Element).localName === "OrderItem" &&
        phase === "96"
      ) {
        const price = target.child(node as Element, "OfferPrice");
        if (price) {
          if (target.child(node as Element, "NetPrice")) price.remove();
          else price.replaceWith(el("NetPrice", price.textContent ?? "0.00"));
        }
      }
    }
  } else {
    if (phase !== "93") throw new Error("workflow-reference-required");
    const scope =
      source.phase === "84" && options.referenceXml
        ? new GaebDocument(options.referenceXml, "scope.x83")
        : source;
    scopeNamespace = scope.namespace;
    const project = scope.child(scope.root, "PrjInfo");
    if (!projectSource && project)
      target.root.insertBefore(clone(project), order);
    const selected = new Set(options.selectedItemIds ?? scope.items.map(idOf));
    for (const entry of scope.items.filter((e) => selected.has(idOf(e)))) {
      const item = el("OrderItem");
      item.setAttribute("ID", idOf(entry));
      item.append(
        el(
          "Qty",
          decimalString(
            roundedDivide(decimal(scope.quantity(entry) || "0", 3), 10n),
            2,
          ),
        ),
        el("QU", scope.value(entry.element, "QU") || "Stk"),
      );
      const description = scope.child(entry.element, "Description");
      if (description) {
        // A fresh description copies structured text, excluding foreign payloads.
        const copy = el("Description");
        for (const name of ["CompleteText", "OutlineText"]) {
          const part = scope.child(description, name);
          if (part) {
            const clean = clone(part) as Element;
            for (const node of [...clean.getElementsByTagName("*")].reverse())
              if (node.namespaceURI !== ns) node.remove();
            for (const node of [clean, ...clean.getElementsByTagName("*")])
              for (const attribute of [...node.attributes])
                if (
                  attribute.namespaceURI &&
                  ![ns, "http://www.w3.org/2000/xmlns/"].includes(
                    attribute.namespaceURI,
                  )
                )
                  node.removeAttributeNode(attribute);
            copy.append(clean);
          }
        }
        item.append(copy);
      }
      item.append(
        el(
          "OrderPosNo",
          String(order.querySelectorAll("OrderItem").length + 1),
        ),
      );
      order.append(item);
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    new XMLSerializer().serializeToString(output.documentElement)
  );
}
