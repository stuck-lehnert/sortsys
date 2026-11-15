import assert from "node:assert/strict";
import { test } from "node:test";
import { createGaebXml } from "./templates";
import {
  type GaebXmlFragment,
  partitionGaebXml,
  renderGaebXml,
} from "./privacy";
import { prepareGaebEditView } from "./editView";
import { prepareGaebPrintView } from "./printView";
import { financialScopeStructure } from "./financialScope";

function groups(fragments: readonly GaebXmlFragment[]) {
  const result = new Map<GaebXmlFragment["facet"], GaebXmlFragment[]>();
  for (const fragment of fragments) {
    const values = result.get(fragment.facet) ?? [];
    values.push(fragment);
    result.set(fragment.facet, values);
  }
  return result;
}

function fixture() {
  const xml = createGaebXml("86", "Fensterarbeiten", "2026-11-13")
    .replace(
      "</BoQInfo>",
      "<Totals><Total>30.00</Total><DiscountAmt>2.00</DiscountAmt><VAT>19.00</VAT><VATAmount>5.32</VATAmount><TotalGross>33.32</TotalGross></Totals></BoQInfo>",
    )
    .replace(
      "<BoQBody/>",
      '<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><Qty>3.000</Qty><QU>m²</QU><UP>10.000</UP><IT>30.00</IT><Description><CompleteText><DetailTxt><Text><p><span>Fensterlaibungen</span></p></Text></DetailTxt></CompleteText></Description><!--Private 73891--></Item></Itemlist></BoQBody>',
    );
  const all = partitionGaebXml(xml, "offer");
  const basis = {
    ...all,
    fragments: all.fragments.filter((fragment) => fragment.facet !== "opaque"),
  };
  const visible = renderGaebXml(basis.layout, groups(basis.fragments));
  return { basis, visible };
}

test("a quantity edit derives native totals while retaining the protected price ciphertext content", () => {
  const { basis, visible } = fixture();
  const result = prepareGaebEditView({
    source: visible.xml.replace("<Qty>3.000</Qty>", "<Qty>4.000</Qty>"),
    basis,
    kind: "offer",
    writable: ["contract-quantities"],
    checkFinancial: true,
  });
  assert.equal(result.financial?.netAmount, "38.00");
  assert.ok(result.xml.includes("<IT>40.00</IT>"));
  assert.ok(
    result.xml.includes(
      "<Total>40.00</Total><DiscountAmt>2.00</DiscountAmt><VAT>19.00</VAT><VATAmount>7.22</VATAmount><TotalGross>45.22</TotalGross>",
    ),
  );
  assert.deepEqual(result.partition.layout, basis.layout);
  assert.deepEqual(
    result.partition.fragments.filter(
      (fragment) => fragment.facet === "offer-prices",
    ),
    basis.fragments.filter((fragment) => fragment.facet === "offer-prices"),
  );
  assert.ok(!result.xml.includes("Private 73891"));
  const printable = prepareGaebPrintView({
    source: result.xml,
    kind: "offer",
    basis,
    writable: ["contract-quantities"],
  });
  assert.ok(printable?.xml.includes("<IT>40.00</IT>"));
});

test("quantity rights do not authorize unit prices, fixed discounts or arbitrary computed values", () => {
  const { basis, visible } = fixture();
  const quantity = visible.xml.replace("<Qty>3.000</Qty>", "<Qty>4.000</Qty>");
  for (
    const source of [
      quantity.replace("<UP>10.000</UP>", "<UP>0.000</UP>"),
      quantity.replace(
        "<DiscountAmt>2.00</DiscountAmt>",
        "<DiscountAmt>0.00</DiscountAmt>",
      ),
      quantity.replace("<IT>30.00</IT>", "<IT>0.00</IT>"),
      quantity.replace(
        "<VATAmount>5.32</VATAmount>",
        "<VATAmount>0.00</VATAmount>",
      ),
    ]
  ) {
    assert.throws(() =>
      prepareGaebEditView({
        source,
        basis,
        kind: "offer",
        writable: ["contract-quantities"],
        checkFinancial: true,
      })
    );
  }
});

test("text-only scope edits leave the financial structure unchanged", () => {
  const { visible } = fixture();
  assert.equal(
    financialScopeStructure(visible.xml),
    financialScopeStructure(
      visible.xml.replace("Fensterlaibungen", "Neue Beschreibung"),
    ),
  );
  assert.notEqual(
    financialScopeStructure(visible.xml),
    financialScopeStructure(
      visible.xml.replace("<Qty>", "<Provis>WithoutTotal</Provis><Qty>"),
    ),
  );
});
