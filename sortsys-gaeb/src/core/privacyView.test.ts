import { test } from "node:test";
import assert from "node:assert/strict";
import {
  partitionGaebXml,
  renderGaebXml,
  updateGaebView,
  type GaebXmlFragment,
  type GaebXmlPartition,
  type GaebXmlRef,
  type GaebPrivateFacet,
} from "./privacy";
import { sealedGaebReference } from "./privacyReferences";
import { createGaebXml } from "./templates";

const first =
  '<Item ID="a" RNoPart="1" v:cost="INTERN-A"><Qty v:rate="INTERNE-MENGE">2.500</Qty><QU>m²</QU><Description><CompleteText><DetailTxt><Text><p><span>Beschreibung A</span></p></Text></DetailTxt></CompleteText></Description><UP>592.510</UP><VendorPrice>FREMDER-PREIS-A</VendorPrice></Item>';
const second =
  '<Item ID="b" RNoPart="2"><Qty>3.750</Qty><QU>m</QU><Description><CompleteText><DetailTxt><Text><p><span>Beschreibung B</span></p></Text></DetailTxt></CompleteText></Description><UP>87.250</UP></Item>';
const source = `\uFEFF${createGaebXml("84", "Fassade").replace("<GAEB ", '<GAEB xmlns:v="https://vendor.invalid/private" ').replace("<BoQBody/>", `<BoQBody><Itemlist>${first}${second}</Itemlist></BoQBody>`)}\r\n`;

function fragmentsOf(fragments: readonly GaebXmlFragment[]) {
  const groups = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
  for (const fragment of fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return groups;
}
function fixture(readable: GaebPrivateFacet[] = []) {
  const original = partitionGaebXml(source, "offer");
  const basis: GaebXmlPartition = {
    layout: original.layout,
    fragments: original.fragments.filter((fragment) =>
      readable.includes(fragment.facet),
    ),
  };
  const view = renderGaebXml(basis.layout, fragmentsOf(basis.fragments));
  function full(updated: GaebXmlPartition) {
    const fragments = fragmentsOf(original.fragments);
    for (const [facet, values] of fragmentsOf(updated.fragments)) {
      fragments.set(facet, values);
    }
    return renderGaebXml(updated.layout, fragments).xml;
  }
  return { basis, view, full, original };
}
function references(partition: GaebXmlPartition, facet: GaebPrivateFacet) {
  const found: GaebXmlRef[] = [];
  const visit = (nodes: GaebXmlPartition["layout"]["nodes"]) => {
    for (const node of nodes) {
      if (node.type === "element") {
        visit(node.children);
      } else if (typeof node.value !== "string" && node.value.facet === facet) {
        found.push(node.value);
      }
    }
  };
  visit(partition.layout.nodes);
  return found;
}

test("scope text changes preserve unread prices, quantities and unknown XML byte for byte", () => {
  const current = fixture();
  assert.equal(current.view.complete, false);
  for (const secret of [
    "592.510",
    "2.500",
    "INTERN-A",
    "INTERNE-MENGE",
    "FREMDER-PREIS-A",
  ]) {
    assert.equal(current.view.xml.includes(secret), false);
  }
  const changed = updateGaebView(
    current.view.xml.replace("Beschreibung A", "Neue Beschreibung"),
    "offer",
    current.basis,
    ["scope"],
  );
  assert.equal(
    current.full(changed),
    source.replace("Beschreibung A", "Neue Beschreibung"),
  );
  assert.deepEqual(changed.fragments, []);
});

test("quantity changes retain opaque attributes without reading or changing them", () => {
  const current = fixture(["contract-quantities"]);
  const changed = updateGaebView(
    current.view.xml.replace("2.500", "4.125"),
    "offer",
    current.basis,
    ["contract-quantities"],
  );
  assert.deepEqual(changed.layout, current.basis.layout);
  assert.equal(current.full(changed), source.replace("2.500", "4.125"));
  assert.equal(JSON.stringify(changed).includes("INTERNE-MENGE"), false);
});

test("optional native prices can be filled without scope writes or zero placeholders", () => {
  for (const emptyItem of [
    '<Item ID="unpriced" RNoPart="0001"/>',
    '<Item ID="unpriced" RNoPart="0001"></Item>',
    '<Item ID="unpriced" RNoPart="0001"><Qty>2.500</Qty><QU>m²</QU></Item>',
  ]) {
    const xml = createGaebXml("84", "Noch nicht kalkuliert").replace(
      "<BoQBody/>",
      `<BoQBody><Itemlist>${emptyItem}</Itemlist></BoQBody>`,
    );
    const basis = partitionGaebXml(xml, "offer");
    assert.equal(
      renderGaebXml(basis.layout, fragmentsOf(basis.fragments)).xml,
      xml,
    );
    const edited = emptyItem.endsWith("/>")
      ? xml.replace(
          emptyItem,
          emptyItem.slice(0, -2) + "><UP>12.500</UP></Item>",
        )
      : xml.replace("</Item>", "<UP>12.500</UP></Item>");
    const updated = updateGaebView(edited, "offer", basis, ["offer-prices"]);
    assert.deepEqual(updated.layout, basis.layout);
    assert.equal(
      renderGaebXml(updated.layout, fragmentsOf(updated.fragments)).xml,
      edited,
    );
    assert.throws(() =>
      updateGaebView(
        edited.replace('RNoPart="0001"', 'RNoPart="0002"'),
        "offer",
        basis,
        ["offer-prices"],
      ),
    );
  }
});

test("expanding an empty position retains unread attributes and its original tag spelling", () => {
  const xml = createGaebXml("84", "Preisergänzung")
    .replace("<GAEB ", '<GAEB xmlns:v="urn:vendor" ')
    .replace(
      "<BoQBody/>",
      '<BoQBody><Itemlist><Item ID="empty" RNoPart="1" v:note="Private 72819" /></Itemlist></BoQBody>',
    );
  const original = partitionGaebXml(xml, "offer");
  const basis = {
    ...original,
    fragments: original.fragments.filter(
      (fragment) => fragment.facet !== "opaque",
    ),
  };
  const view = renderGaebXml(basis.layout, fragmentsOf(basis.fragments));
  assert.ok(!view.xml.includes("Private 72819"));
  const edited = view.xml.replace(
    /(<Item[^>]+)\/>/,
    "$1><UP>12.000</UP></Item>",
  );
  const updated = updateGaebView(edited, "offer", basis, ["offer-prices"]);
  assert.deepEqual(updated.layout, basis.layout);
  const all = fragmentsOf(original.fragments);
  all.set(
    "offer-prices",
    updated.fragments.filter((fragment) => fragment.facet === "offer-prices"),
  );
  assert.equal(
    renderGaebXml(updated.layout, all).xml,
    xml.replace(
      'v:note="Private 72819" />',
      'v:note="Private 72819" ><UP>12.000</UP></Item>',
    ),
  );
});

test("a private optional price cannot discard an unread nested attribute", () => {
  const xml = createGaebXml("84", "Preis mit Herstellerangabe")
    .replace("<GAEB ", '<GAEB xmlns:v="urn:vendor" ')
    .replace(
      "<BoQBody/>",
      '<BoQBody><Itemlist><Item ID="window" RNoPart="1"><UP v:note="Private 8316">12.000</UP></Item></Itemlist></BoQBody>',
    );
  const original = partitionGaebXml(xml, "offer");
  const basis = {
    ...original,
    fragments: original.fragments.filter(
      (fragment) => fragment.facet !== "opaque",
    ),
  };
  const view = renderGaebXml(basis.layout, fragmentsOf(basis.fragments));
  const removed = view.xml.replace(/<UP\b[^>]*>[\s\S]*?<\/UP>/, "");
  assert.throws(() =>
    updateGaebView(removed, "offer", basis, ["offer-prices"]),
  );
});

test("optional prices preserve a prefixed native namespace when an empty item expands", () => {
  const namespace = "http://www.gaeb.de/GAEB_DA_XML/DA84/3.3";
  const xml = createGaebXml("84", "Präfixe")
    .replace(
      "<BoQBody/>",
      '<BoQBody><Itemlist><Item ID="window" RNoPart="1"/></Itemlist></BoQBody>',
    )
    .replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, "<$1g:$2")
    .replace("<g:GAEB ", `<g:GAEB xmlns:g="${namespace}" `);
  const basis = partitionGaebXml(xml, "offer");
  const edited = xml.replace(
    '<g:Item ID="window" RNoPart="1"/>',
    '<g:Item ID="window" RNoPart="1"><g:UP>12.000</g:UP></g:Item>',
  );
  const updated = updateGaebView(edited, "offer", basis, ["offer-prices"]);
  assert.deepEqual(updated.layout, basis.layout);
  assert.equal(
    renderGaebXml(updated.layout, fragmentsOf(updated.fragments)).xml,
    edited,
  );
});

test("optional supplier prices keep their own permissions and native order", () => {
  const xml = createGaebXml("94", "Lieferantenpreis").replace(
    "</Order>",
    "<OrderItem><Qty>2.00</Qty><QU>St</QU><PriceBasis>1.00</PriceBasis><OrderPosNo>1</OrderPosNo></OrderItem></Order>",
  );
  const basis = partitionGaebXml(xml, "procurement");
  const edited = xml.replace(
    "<PriceBasis>",
    "<NetPrice>12.00</NetPrice><PriceBasis>",
  );
  const updated = updateGaebView(edited, "procurement", basis, ["procurement"]);
  assert.deepEqual(updated.layout, basis.layout);
  assert.equal(
    renderGaebXml(updated.layout, fragmentsOf(updated.fragments)).xml,
    edited,
  );
  assert.throws(() =>
    updateGaebView(edited, "procurement", basis, ["offer-prices"]),
  );
});

test("readable fields do not become writable and scope changes cannot inject a price", () => {
  const current = fixture(["contract-quantities", "offer-prices"]);
  for (const changed of [
    current.view.xml.replace("2.500", "99.000"),
    current.view.xml.replace("592.510", "0.000"),
    current.view.xml.replace("</Item>", "<UP>0.000</UP></Item>"),
  ]) {
    assert.throws(() =>
      updateGaebView(changed, "offer", current.basis, ["scope"]),
    );
  }
  assert.throws(() =>
    updateGaebView(
      current.view.xml.replace("Beschreibung A", "Unzulässig"),
      "offer",
      current.basis,
      ["offer-prices"],
    ),
  );
});

test("sealed references cannot be duplicated, removed, replaced or moved between positions", () => {
  const current = fixture();
  const prices = references(current.basis, "offer-prices");
  const priceA = sealedGaebReference(prices[0]!);
  const priceB = sealedGaebReference(prices[1]!);
  const swapped = current.view.xml
    .replace(priceA, "__price_a__")
    .replace(priceB, priceA)
    .replace("__price_a__", priceB);
  for (const changed of [
    current.view.xml.replace(priceA, ""),
    current.view.xml.replace(priceA, priceA + priceA),
    current.view.xml.replace(priceA, "<!--sortsys:sealed:pZmFrZQ-->"),
    swapped,
  ]) {
    assert.throws(() =>
      updateGaebView(changed, "offer", current.basis, ["scope"]),
    );
  }
});

test("private references keep their order within a position and cannot become public attributes", () => {
  const current = fixture();
  const quantity = sealedGaebReference(
    references(current.basis, "contract-quantities")[0]!,
  );
  const price = sealedGaebReference(
    references(current.basis, "offer-prices")[0]!,
  );
  const reordered = current.view.xml
    .replace(quantity, "__quantity__")
    .replace(price, quantity)
    .replace("__quantity__", price);
  assert.throws(() =>
    updateGaebView(reordered, "offer", current.basis, ["scope"]),
  );
  const attribute = /data-sortsys-sealed-[^=]+=""/.exec(current.view.xml)![0];
  assert.throws(() =>
    updateGaebView(
      current.view.xml.replace(
        attribute,
        attribute.replace('=""', '="changed"'),
      ),
      "offer",
      current.basis,
      ["scope"],
    ),
  );
});

test("removing a whole position keeps its unread private values as unreachable history", () => {
  const current = fixture(["offer-prices"]);
  const changedSource = current.view.xml.replace(
    /<Item\b[^>]*\bID="a"[^>]*>[\s\S]*?<\/Item>/,
    "",
  );
  const changed = updateGaebView(changedSource, "offer", current.basis, [
    "scope",
  ]);
  assert.equal(current.full(changed), source.replace(first, ""));
  assert.deepEqual(changed.fragments, current.basis.fragments);
});

test("partial readers reject injected scope prices and references rebound in a signed layout", () => {
  const current = fixture();
  const injected = structuredClone(current.basis.layout);
  injected.nodes.push({ type: "raw", value: "<UP>0.000</UP>" });
  assert.throws(() => renderGaebXml(injected, new Map()));
  const swapped = structuredClone(current.basis);
  const prices = references(swapped, "offer-prices");
  const previous = prices[0]!.id;
  prices[0]!.id = prices[1]!.id;
  prices[1]!.id = previous;
  assert.throws(() => renderGaebXml(swapped.layout, new Map()));
});

test("a partial update cannot change the native phase or turn a signed file into an editable one", () => {
  const current = fixture();
  assert.throws(() =>
    updateGaebView(
      current.view.xml
        .replaceAll("DA84", "DA83")
        .replace("<DP>84</DP>", "<DP>83</DP>"),
      "offer",
      current.basis,
      ["scope"],
    ),
  );
  assert.throws(() =>
    updateGaebView(
      current.view.xml,
      "offer",
      { ...current.basis, layout: { ...current.basis.layout, signed: true } },
      ["scope"],
    ),
  );
});

test("native identifiers cannot collide with the structural paths of private child elements", () => {
  const unusual = source.replace('ID="b"', 'ID="a/Qty[0]"');
  const partition = partitionGaebXml(unusual, "offer");
  const quantities = partition.fragments.filter(
    (fragment) => fragment.facet === "contract-quantities",
  );
  const partial = renderGaebXml(partition.layout, fragmentsOf(quantities));
  const basis = { layout: partition.layout, fragments: quantities };
  const updated = updateGaebView(
    partial.xml.replace("Beschreibung B", "Geändert"),
    "offer",
    basis,
    ["scope"],
  );
  assert.equal(
    renderGaebXml(updated.layout, fragmentsOf(partition.fragments)).xml,
    unusual.replace("Beschreibung B", "Geändert"),
  );
});

test("a signed partial layout cannot reassign an unread attribute to an ancestor", () => {
  const current = fixture(["contract-quantities"]);
  const forged = structuredClone(current.basis);
  const quantity = forged.fragments.find(
    (fragment) =>
      fragment.facet === "contract-quantities" &&
      typeof fragment.content !== "string" &&
      fragment.content.type === "element" &&
      fragment.content.open.some((value) => typeof value !== "string"),
  );
  assert.ok(
    quantity &&
      typeof quantity.content !== "string" &&
      quantity.content.type === "element",
  );
  const attribute = quantity.content.open.find(
    (value) => typeof value !== "string",
  );
  assert.ok(attribute && typeof attribute !== "string");
  quantity.content.open = quantity.content.open.filter(
    (value) => value !== attribute,
  );
  const pending = [...forged.layout.nodes];
  let attached = false;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type !== "element") {
      continue;
    }
    if (node.key === "@Item:a") {
      node.open.splice(1, 0, attribute);
      attached = true;
      break;
    }
    pending.push(...node.children);
  }
  assert.equal(attached, true);
  assert.throws(() =>
    renderGaebXml(forged.layout, fragmentsOf(forged.fragments)),
  );
});
