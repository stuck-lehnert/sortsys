import { test } from "node:test";
import assert from "node:assert/strict";
import { createGaebXml } from "./templates";
import {
  inspectFinancialView,
  readFinancialView,
  recalculateFinancialView,
} from "./financialView";
import { partitionGaebXml, renderGaebXml } from "./privacy";

function item(
  quantity = "2.500",
  price = "10.005",
  total = "25.01",
  extra = "",
) {
  const fields = ['<Item ID="window" RNoPart="0001">'];
  if (quantity) {
    fields.push(`<Qty>${quantity}</Qty>`);
  }
  fields.push(
    `<QU>m²</QU><UP>${price}</UP><IT>${total}</IT>`,
    extra,
    "</Item>",
  );
  return fields.join("");
}
function quote(body = item(), phase: "83" | "84" | "86" = "86") {
  return createGaebXml(phase, "Fensterarbeiten", "2026-11-13").replace(
    "<BoQBody/>",
    `<BoQBody><Itemlist>${body}</Itemlist></BoQBody>`,
  );
}

test("an unfinished price calculation remains editable without a fabricated total", () => {
  const unfinished = quote(item().replace("<UP>10.005</UP>", ""), "84");
  assert.deepEqual(inspectFinancialView(unfinished), {
    phase: "84",
    netAmount: null,
  });
  assert.throws(() => readFinancialView(unfinished), /missing-amount-input/);

  const finished = unfinished.replace("<IT>", "<UP>10.005</UP><IT>");
  assert.equal(inspectFinancialView(finished).netAmount, "25.01");
});

test("derived native amounts are repaired without changing the input or unknown XML", () => {
  const original = "\uFEFF" +
    quote(item("4.125", "10.005", "1.00"))
      .replace("<GAEB ", '<GAEB xmlns:v="urn:private" ')
      .replace(
        "<IT>1.00</IT>",
        "<IT v:note='kept'>\r\n<!--Unbekannter Hinweis 8172-->1.00\r\n</IT>",
      )
      .replace(
        "</Item>",
        "<v:Extra><v:IT>secret 7182</v:IT></v:Extra></Item>",
      ) +
    "\r\n";
  assert.throws(() => readFinancialView(original), /item-total/);
  const result = recalculateFinancialView(original);
  assert.equal(result.netAmount, "41.27");
  assert.equal(
    result.xml,
    original
      .replace(
        "<!--Unbekannter Hinweis 8172-->1.00",
        "<!--Unbekannter Hinweis 8172-->41.27",
      )
      .replace("<Total>0.00</Total>", "<Total>41.27</Total>"),
  );
  assert.equal(readFinancialView(result.xml).netAmount, "41.27");
});

test("unfinished calculations never replace group totals with a partial zero", () => {
  const body = '<BoQBody><BoQCtgy ID="group" RNoPart="01"><BoQBody><Itemlist>' +
    item().replace("<UP>10.005</UP>", "") +
    "</Itemlist></BoQBody><Totals><Total>87.00</Total></Totals></BoQCtgy></BoQBody>";
  const original = createGaebXml("86", "Noch offen").replace(
    "<BoQBody/>",
    body,
  );
  const result = recalculateFinancialView(original);
  assert.equal(result.netAmount, null);
  assert.equal(result.xml, original);
});

test("recalculation covers group discounts and VAT while fixed discounts remain inputs", () => {
  const body = '<BoQBody><BoQCtgy ID="group" RNoPart="01"><BoQBody><Itemlist>' +
    item("3.000", "10.000", "1.00") +
    "</Itemlist></BoQBody><Totals><Total>0.00</Total><DiscountPcnt>10.000000</DiscountPcnt><DiscountAmt>0.00</DiscountAmt><TotAfterDisc>0.00</TotAfterDisc></Totals></BoQCtgy></BoQBody>";
  const original = createGaebXml("86", "Nachlässe")
    .replace("<BoQBody/>", body)
    .replace(
      "</BoQInfo>",
      "<Totals><Total>0.00</Total><DiscountAmt>2.00</DiscountAmt><TotAfterDisc>0.00</TotAfterDisc><VAT>19.00</VAT><VATAmount>0.00</VATAmount><TotalGross>0.00</TotalGross></Totals></BoQInfo>",
    );
  const result = recalculateFinancialView(original);
  assert.equal(result.netAmount, "25.00");
  assert.ok(result.xml.includes("<IT>30.00</IT>"));
  assert.ok(
    result.xml.includes(
      "<DiscountPcnt>10.000000</DiscountPcnt><DiscountAmt>3.00</DiscountAmt><TotAfterDisc>27.00</TotAfterDisc>",
    ),
  );
  assert.ok(
    result.xml.includes(
      "<Total>27.00</Total><DiscountAmt>2.00</DiscountAmt><TotAfterDisc>25.00</TotAfterDisc>",
    ),
  );
  assert.ok(
    result.xml.includes(
      "<VATAmount>4.75</VATAmount><TotalGross>29.75</TotalGross>",
    ),
  );
});

test("an unfinished position cannot hide unsupported or malformed later pricing", () => {
  const unfinished = item().replace("<UP>10.005</UP>", "");
  const later = item()
    .replace('ID="window"', 'ID="second"')
    .replace('RNoPart="0001"', 'RNoPart="0002"');
  assert.throws(
    () =>
      inspectFinancialView(
        quote(
          unfinished +
            later.replace("</Item>", "<UPComp1>1.00</UPComp1></Item>"),
        ),
      ),
    /unsupported-pricing/,
  );
  assert.throws(
    () =>
      inspectFinancialView(
        quote(unfinished + later.replace("<IT>25.01</IT>", "<IT>0.00</IT>")),
      ),
    /item-total/,
  );
  assert.throws(() =>
    inspectFinancialView(
      quote(unfinished.replace("<Qty>2.500</Qty>", "<Qty>broken</Qty>")),
    )
  );
});

test("financial totals use exact item rounding and ignore foreign extension items", () => {
  const xml = quote(
    item() +
      item("1.000", "0.005", "0.01")
        .replaceAll("window", "second")
        .replaceAll('RNoPart="0001"', 'RNoPart="0002"'),
  );
  assert.equal(readFinancialView(xml).netAmount, "25.02");
  const extension = `<vendor:Extra xmlns:vendor="urn:private:calculation">${
    item("1.000", "999.000", "999.00")
  }</vendor:Extra>`;
  assert.equal(
    readFinancialView(quote(item("2.500", "10.005", "25.01", extension)))
      .netAmount,
    "25.01",
  );
});

test("missing quantities require an unambiguous readable reference while explicit zero remains zero", () => {
  const target = quote(item(""), "84");
  assert.throws(() => readFinancialView(target), /missing-amount-input/);
  assert.equal(
    readFinancialView(target, quote(item(), "83")).netAmount,
    "25.01",
  );
  assert.throws(
    () => readFinancialView(target, quote(item(""), "83")),
    /missing-amount-input/,
  );
  assert.equal(
    readFinancialView(quote(item("0.000", "10.005", "0.00"))).netAmount,
    "0.00",
  );
  assert.throws(
    () => readFinancialView(target, quote(item() + item(), "83")),
    /ambiguous-position/,
  );
});

test("GAEB 3.1 uses its header phase and contradictory headers or duplicate bodies are rejected", () => {
  const source = quote();
  const legacy = source.replace(
    "http://www.gaeb.de/GAEB_DA_XML/DA86/3.3",
    "http://www.gaeb.de/GAEB_DA_XML/200407",
  );
  assert.deepEqual(readFinancialView(legacy), {
    phase: "86",
    netAmount: "25.01",
  });
  assert.throws(
    () => readFinancialView(source.replace("<DP>86</DP>", "<DP>84</DP>")),
    /financial-view-phase/,
  );
  assert.throws(
    () =>
      readFinancialView(
        source.replace("</GAEB>", "<Invoice><DP>89</DP></Invoice></GAEB>"),
      ),
    /financial-view-structure/,
  );
});

test("inconsistent item totals, duplicated scalars and unsupported price rules are rejected", () => {
  assert.throws(
    () => readFinancialView(quote(item("2.500", "10.005", "25.00"))),
    /item-total/,
  );
  assert.throws(
    () =>
      readFinancialView(
        quote(item("2.500", "10.005", "25.01", "<Qty>2.500</Qty>")),
      ),
    /structure/,
  );
  assert.throws(
    () =>
      readFinancialView(
        quote(item("2.500", "10.005", "25.01", "<UPComp1>1.000</UPComp1>")),
      ),
    /unsupported-pricing/,
  );
});

test("contractual lump sums and provisional flags are inherited without exposing reference prices", () => {
  const reference = partitionGaebXml(
    quote(
      item("3.000", "99.000", "99.00", "<LumpSumItem>Yes</LumpSumItem>"),
      "83",
    ),
    "offer",
  );
  const quantities = reference.fragments.filter(
    (fragment) => fragment.facet === "contract-quantities",
  );
  const view = renderGaebXml(
    reference.layout,
    new Map([["contract-quantities", quantities]]),
  );
  assert.ok(view.xml.includes("<LumpSumItem>Yes</LumpSumItem>"));
  assert.ok(!view.xml.includes("99.000"));
  assert.equal(
    readFinancialView(quote(item("", "10.000", "10.00"), "84"), view.xml)
      .netAmount,
    "10.00",
  );
  const optional = quote(
    item("3.000", "1.000", "3.00", "<Provis>WithoutTotal</Provis>"),
    "83",
  );
  assert.equal(
    readFinancialView(quote(item("", "10.000", "30.00"), "84"), optional)
      .netAmount,
    "0.00",
  );
});

test("trade price bases use exact decimal division", () => {
  const source = createGaebXml("94", "Material", "2026-11-13").replace(
    "</Order>",
    "<OrderItem><OrderPosNo>1</OrderPosNo><Qty>3.00</Qty><QU>St</QU><NetPrice>100.00</NetPrice><PriceBasis>100.00</PriceBasis></OrderItem></Order>",
  );
  assert.equal(readFinancialView(source).netAmount, "3.00");
  assert.throws(
    () =>
      readFinancialView(
        source.replace(
          "<PriceBasis>100.00</PriceBasis>",
          "<PriceBasis>0.00</PriceBasis>",
        ),
      ),
    /unsupported-pricing/,
  );
});

test("orders and invoices use their own quantities and flags while lump sums need no invented quantity", () => {
  const reference = quote(
    item("3.000", "10.000", "30.00", "<Provis>WithoutTotal</Provis>"),
    "83",
  );
  assert.equal(
    readFinancialView(quote(item("3.000", "10.000", "30.00")), reference)
      .netAmount,
    "30.00",
  );
  assert.throws(
    () => readFinancialView(quote(item("", "10.000", "30.00")), reference),
    /missing-amount-input/,
  );
  assert.equal(
    readFinancialView(
      quote(item("", "10.000", "10.00", "<LumpSumItem>Yes</LumpSumItem>")),
    ).netAmount,
    "10.00",
  );
  const invoice = createGaebXml("89", "Rechnung", "2026-11-13")
    .replace(
      "<BoQBody/>",
      `<BoQBody><Itemlist>${item("", "10.000", "30.00")}</Itemlist></BoQBody>`,
    )
    .replace(
      "<Total>0.00</Total></InvoiceShare>",
      "<Total>30.00</Total></InvoiceShare>",
    );
  assert.throws(
    () => readFinancialView(invoice, reference),
    /missing-amount-input/,
  );
});

test("unread extensions stay sealed while price-affecting native flags stay available with their proper keys", () => {
  const xml = quote(
    item(
      "2.500",
      "10.005",
      "25.01",
      "<Provis>WithoutTotal</Provis><SecretVendorCalculation>Secret 827461</SecretVendorCalculation>",
    ),
  );
  const partition = partitionGaebXml(xml, "offer");
  const fragments = new Map();
  for (const fragment of partition.fragments) {
    if (fragment.facet === "opaque") {
      continue;
    }
    const group = fragments.get(fragment.facet) ?? [];
    group.push(fragment);
    fragments.set(fragment.facet, group);
  }
  const view = renderGaebXml(partition.layout, fragments);
  assert.equal(view.complete, false);
  assert.ok(!view.xml.includes("Secret 827461"));
  assert.ok(view.xml.includes("<Provis>WithoutTotal</Provis>"));
  assert.equal(readFinancialView(view.xml).netAmount, "0.00");
});

test("mixed hierarchy levels retain direct items, group discounts, exclusions and a header surcharge", () => {
  const direct = item("1.000", "5.000", "5.00");
  const nested = item("1.000", "20.000", "20.00").replace(
    'ID="window"',
    'ID="nested"',
  );
  const excluded = item("1.000", "100.000", "100.00").replace(
    'ID="window"',
    'ID="excluded"',
  );
  const body = [
    "<BoQBody>",
    '<BoQCtgy ID="group" RNoPart="01">',
    "<BoQBody>",
    '<BoQCtgy ID="subgroup" RNoPart="02">',
    `<BoQBody><Itemlist>${nested}</Itemlist></BoQBody>`,
    "<Totals><DiscountPcnt>10.000000</DiscountPcnt></Totals>",
    "</BoQCtgy>",
    '<BoQCtgy ID="optional" RNoPart="03"><NotApplBoQ>Yes</NotApplBoQ>',
    `<BoQBody><Itemlist>${excluded}</Itemlist></BoQBody></BoQCtgy>`,
    `<Itemlist>${direct}</Itemlist>`,
    "</BoQBody></BoQCtgy></BoQBody>",
  ].join("");
  const source = createGaebXml("86", "Gemischte Gliederung", "2026-11-13")
    .replace("<BoQBody/>", body)
    .replace(
      "</BoQInfo>",
      "<Totals><DiscountPcnt>-5.000000</DiscountPcnt></Totals></BoQInfo>",
    );
  assert.equal(readFinancialView(source).netAmount, "24.15");
});

test("a contradictory source ID and position number cannot select another quantity", () => {
  const first = item("3.000", "10.000", "30.00");
  const second = item("9.000", "10.000", "90.00")
    .replace('ID="window"', 'ID="other"')
    .replace('RNoPart="0001"', 'RNoPart="0002"');
  const target = quote(item("", "10.000", "30.00"), "84").replace(
    'RNoPart="0001"',
    'RNoPart="0002"',
  );
  assert.throws(
    () => readFinancialView(target, quote(first + second, "83")),
    /ambiguous-position/,
  );
});

test("unsupported sibling price rules and missing BoQ bodies cannot silently produce a subtotal", () => {
  const source = quote();
  for (const name of ["MarkupItem", "HourItem", "MaterialItem"]) {
    const modified = source.replace("</Itemlist>", `<${name}/></Itemlist>`);
    assert.throws(() => readFinancialView(modified), /unsupported-pricing/);
  }
  assert.throws(
    () =>
      readFinancialView(
        source.replace(
          "</BoQInfo>",
          "<Totals><TotalLSUM>50.00</TotalLSUM></Totals></BoQInfo>",
        ),
      ),
    /unsupported-pricing/,
  );
  assert.throws(
    () =>
      readFinancialView(
        createGaebXml("86", "Leer", "2026-11-13").replace("<BoQBody/>", ""),
      ),
    /structure/,
  );
});

test("final accounts need readable original invoice amounts, not an inferred VAT conversion", () => {
  const body = item("2.500", "10.005", "25.01")
    .replace("<Qty>", "<BillQty>")
    .replace("</Qty>", "</BillQty>");
  const source = createGaebXml("89", "Schlussrechnung", "2026-11-13")
    .replace("<BoQBody/>", `<BoQBody><Itemlist>${body}</Itemlist></BoQBody>`)
    .replace(
      "<InvoiceType>single invoice</InvoiceType>",
      "<InvoiceType>final account</InvoiceType>",
    )
    .replace(
      "<Total>0.00</Total></InvoiceShare>",
      "<Total>25.01</Total></InvoiceShare>",
    )
    .replace(
      "<TotalGross>",
      "<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Total>11.91</Total></InvoiceShare><TotalGross>",
    );
  assert.throws(() => readFinancialView(source), /missing-amount-input/);
  const withOriginal = source.replace(
    "<TotalGross>",
    "<InvoiceMadeOut><TotalVAT>1.90</TotalVAT><Total>10.01</Total></InvoiceMadeOut><TotalGross>",
  );
  assert.equal(readFinancialView(withOriginal).netAmount, "15.00");
  const partition = partitionGaebXml(withOriginal, "final_invoice");
  const groups = new Map();
  for (const fragment of partition.fragments) {
    if (fragment.facet !== "billing") continue;
    const entries = groups.get(fragment.facet) ?? [];
    entries.push(fragment);
    groups.set(fragment.facet, entries);
  }
  assert.equal(
    readFinancialView(renderGaebXml(partition.layout, groups).xml).netAmount,
    "15.00",
  );
});
