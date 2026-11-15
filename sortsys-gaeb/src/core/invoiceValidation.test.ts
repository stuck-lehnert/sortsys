import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateInvoiceXml,
  type InvoiceValidationOptions,
} from "./invoiceValidation";
import { createGaebXml } from "./templates";

function invoiceXml(
  quantity = "2.500",
  price = "10.005",
  total = "25.01",
  gross = "29.76",
) {
  return createGaebXml("89", "Fensterarbeiten", "2026-11-12")
    .replace(
      "<BoQBody/>",
      `<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><BillQty>${quantity}</BillQty><QU>m²</QU><UP>${price}</UP><IT>${total}</IT></Item></Itemlist></BoQBody>`,
    )
    .replace(
      "<Total>0.00</Total></InvoiceShare>",
      `<Total>${total}</Total></InvoiceShare>`,
    )
    .replace(
      "<TotalGross>0.00</TotalGross>",
      `<TotalGross>${gross}</TotalGross>`,
    );
}

const options: InvoiceValidationOptions = {
  kind: "invoice",
  vatRate: "19.00",
  previousInvoices: [],
  netAmount: "25.01",
};

test("invoice validation rounds each item with exact decimal arithmetic and keeps the original XML", () => {
  const source = invoiceXml();
  const result = validateInvoiceXml(source, options);
  assert.equal(result.xml, source);
  assert.deepEqual(result.details, {
    invoiceDate: "2026-11-12",
    dueDate: "2026-11-26",
    serviceStart: "2026-11-12",
    serviceEnd: "2026-11-12",
    totalNet: "25.01",
    deductedNet: "0.00",
    grossAmount: "29.76",
    netAmount: "25.01",
  });
  const numbered = validateInvoiceXml(source, {
    ...options,
    invoiceNumber: "00238427-12",
    requireAddresses: true,
  });
  assert.equal(
    numbered.xml,
    source.replace(
      "<InvoiceNo>ENTWURF</InvoiceNo>",
      "<InvoiceNo>00238427-12</InvoiceNo>",
    ),
  );
  const selfClosing = validateInvoiceXml(
    source.replace("<InvoiceNo>ENTWURF</InvoiceNo>", "<InvoiceNo/>"),
    { ...options, invoiceNumber: "17" },
  ).xml;
  assert.ok(selfClosing.includes("<InvoiceNo>17</InvoiceNo>"));
});

test("final invoices deduct issued progress invoices, including their rounded VAT", () => {
  const previous = {
    id: "3",
    invoiceNumber: "12",
    invoiceDate: "2026-11-10",
    netAmount: "10.01",
    grossAmount: "11.91",
    paidAmount: "0.00",
    vatRate: "19.00",
  };
  const source = invoiceXml()
    .replace("single invoice", "final account")
    .replace(
      "<TotalGross>29.76</TotalGross>",
      "<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Total>11.91</Total></InvoiceShare><TotalGross>17.85</TotalGross>",
    );
  const finalOptions = {
    ...options,
    kind: "final_invoice" as const,
    previousInvoices: [previous],
    netAmount: "15.00",
  };
  assert.partialDeepStrictEqual(
    validateInvoiceXml(source, finalOptions).details,
    {
      deductedNet: "10.01",
      grossAmount: "17.85",
      netAmount: "15.00",
    },
  );
  assert.throws(
    () =>
      validateInvoiceXml(source, {
        ...finalOptions,
        previousInvoices: [{ ...previous, grossAmount: "11.92" }],
      }),
    /invoice-previous-invoices/,
  );
  assert.throws(
    () =>
      validateInvoiceXml(source, {
        ...finalOptions,
        previousInvoices: [{ ...previous, vatRate: "7.00" }],
      }),
    /invoice-vat-chain/,
  );
});

test("invoice validation rejects inconsistent totals, complex pricing and hostile XML", () => {
  const source = invoiceXml();
  for (const malformed of [
    source.replace("<IT>25.01", "<IT>25.02"),
    source.replace("<TotalGross>29.76", "<TotalGross>29.77"),
    source.replace("<BillQty>2.500", "<BillQty>2.5001"),
    source.replace("<UP>10.005", "<UP>-10.005"),
    source.replace("<QU>m²</QU>", "<QU>m²</QU><LumpSumItem>Yes</LumpSumItem>"),
    source.replace("<Percent>19.00", "<Percent>7.00"),
    source.replace("<InvoiceDate>2026-11-12", "<InvoiceDate>2026-02-30"),
    source.replaceAll("2026-11-12", "9999-12-31"),
    source.replace(
      "</InvoiceHeader>",
      "<InvoiceDate>2026-11-12</InvoiceDate></InvoiceHeader>",
    ),
    source.replace(
      "<GAEB ",
      "<!DOCTYPE GAEB [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]><GAEB ",
    ),
    source.replace(
      "</GAEB>",
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></GAEB>',
    ),
  ]) {
    assert.throws(() => validateInvoiceXml(malformed, options));
  }
  assert.throws(
    () => validateInvoiceXml(source, { ...options, netAmount: "25.02" }),
    /invoice-total/,
  );
  assert.throws(
    () =>
      validateInvoiceXml(source.replace("<TaxNo>DEMO</TaxNo>", "<TaxNo/>"), {
        ...options,
        invoiceNumber: "1",
        requireAddresses: true,
      }),
    /invoice-tax-number/,
  );
});
