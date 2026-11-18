import { expect, test } from "bun:test";
import { GAEB_CONTENT_FACETS } from "@sortsys/gaeb";
import {
  checkedFinancialView,
  checkedPrintAssessment,
  checkedPrintView,
  documentContentView,
  documentEditorAccess,
  financialInputsReadable,
  referenceInputsReadable,
  scopedDocumentEditor,
} from "./documentEditor";

test("document print and validation callbacks cannot outlive their editor context", async () => {
  const context = new AbortController();
  let finish;
  let calls = 0;
  const session = scopedDocumentEditor(
    {
      contentView: {
        access: { complete: false, readable: ["scope"], writable: ["scope"] },
        async validate() {
          calls += 1;
          return { valid: true, issues: [] };
        },
        preparePrint() {
          calls += 1;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
    context.signal,
    () => context.signal.throwIfAborted(),
  );
  const pending = session.contentView.preparePrint("visible XML");
  context.abort(new Error("Editor rights revoked"));
  finish({ xml: "late print", referenceXml: undefined });
  await expect(pending).rejects.toThrow("Editor rights revoked");
  await expect(
    session.contentView.preparePrint("another print"),
  ).rejects.toThrow("Editor rights revoked");
  await expect(session.contentView.validate("another edit")).rejects.toThrow(
    "Editor rights revoked",
  );
  expect(calls).toBe(1);
});

test("a refused print and an aborted worker never provide a usable printable view", async () => {
  const context = new AbortController();
  const processor = {
    async printView() {
      return null;
    },
  };
  expect(await checkedPrintView(processor, {}, context.signal)).toBeNull();
  const view = documentContentView(
    processor,
    {},
    "offer",
    { complete: false, readable: ["scope"], writable: [] },
    false,
    context.signal,
    () => context.signal.throwIfAborted(),
    {},
  );
  await expect(view.preparePrint("XML")).rejects.toThrow(
    "print-view-incomplete",
  );
  processor.printView = async () => {
    context.abort(new Error("Print access revoked"));
    return { xml: "too late" };
  };
  await expect(checkedPrintView(processor, {}, context.signal)).rejects.toThrow(
    "Print access revoked",
  );
});

test("an incomplete print keeps its guarded capability and can become ready without reopening", async () => {
  const context = new AbortController();
  const processor = {
    async assessPrint() {
      return { status: "incomplete-pricing" };
    },
    async printView({ source }) {
      return source === "complete XML" ? { xml: source } : null;
    },
  };
  expect(
    (await checkedPrintAssessment(processor, {}, context.signal)).status,
  ).toBe("incomplete-pricing");
  const view = documentContentView(
    processor,
    {},
    "offer",
    {
      complete: false,
      readable: ["scope", "offer-prices"],
      writable: ["offer-prices"],
    },
    false,
    context.signal,
    () => context.signal.throwIfAborted(),
    { readiness: "incomplete-pricing" },
  );
  expect(view.printReadiness).toBe("incomplete-pricing");
  await expect(view.preparePrint("incomplete XML")).rejects.toThrow(
    "print-view-incomplete",
  );
  expect(await view.preparePrint("complete XML")).toEqual({
    xml: "complete XML",
  });
});

test("a cancelled print assessment rejects late readiness and preserves worker failures", async () => {
  const context = new AbortController();
  let complete;
  const processor = {
    assessPrint() {
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const pending = checkedPrintAssessment(processor, {}, context.signal);
  context.abort(new Error("Print access revoked"));
  complete({ status: "ready", view: { xml: "late XML" } });
  await expect(pending).rejects.toThrow("Print access revoked");
  const failingProcessor = {
    async assessPrint() {
      throw new Error("financial-view-item-total");
    },
  };
  await expect(
    checkedPrintAssessment(failingProcessor, {}, new AbortController().signal),
  ).rejects.toThrow("financial-view-item-total");
});

test("price edits need readable inputs, not unrelated opaque contents", () => {
  const access = {
    complete: false,
    readable: ["scope", "contract-quantities", "offer-prices"],
    writable: ["offer-prices"],
  };
  expect(financialInputsReadable(access, "84", "offer")).toBe(true);
  expect(financialInputsReadable(access, "84", "offer", ["measurement"])).toBe(
    false,
  );
  expect(financialInputsReadable(access, "89", "invoice")).toBe(false);
  expect(financialInputsReadable(access, "83", "offer")).toBe(false);
  expect(documentEditorAccess(access, true, "84")).toEqual({
    ...access,
    pricingSupported: true,
  });
  expect(documentEditorAccess(access, false, "84").writable).toEqual([]);
});

test("a complete unpriced inquiry retains the verified rights for its hierarchy", () => {
  const access = {
    complete: true,
    readable: GAEB_CONTENT_FACETS,
    writable: GAEB_CONTENT_FACETS,
  };
  expect(documentEditorAccess(access, false, "83")).toEqual({
    ...access,
    pricingSupported: false,
  });
  for (const restricted of [
    { ...access, complete: false },
    { ...access, writable: access.writable.filter((facet) => facet !== "opaque") },
  ]) {
    expect(documentEditorAccess(restricted, false, "83").writable).toEqual([
      "scope",
      "contract-quantities",
      "measurement",
      "attachment",
    ]);
  }
  expect(documentEditorAccess(access, false, "84").writable).toEqual([
    "scope",
    "measurement",
    "attachment",
  ]);
});

test("a readable reference needs actual contractual quantities, including any measurement basis", () => {
  const reference = {
    access: {
      complete: false,
      readable: ["scope", "contract-quantities"],
      writable: [],
    },
    missing: ["opaque"],
  };
  expect(referenceInputsReadable(true, reference)).toBe(true);
  expect(referenceInputsReadable(false, { missing: [] })).toBe(true);
  expect(referenceInputsReadable(true, { missing: [] })).toBe(false);
  expect(
    referenceInputsReadable(true, {
      ...reference,
      missing: ["measurement"],
    }),
  ).toBe(false);
  expect(
    referenceInputsReadable(true, {
      ...reference,
      access: { ...reference.access, readable: ["scope"] },
    }),
  ).toBe(false);
});

test("invoice amounts can remain visible without enabling edits that need the parent ledger", () => {
  const access = {
    complete: false,
    readable: ["scope", "billing"],
    writable: ["scope", "billing"],
  };
  const restricted = documentEditorAccess(access, true, "89", false);
  expect(restricted.pricingSupported).toBe(true);
  expect(restricted.writable).toEqual(["scope"]);
  const inquiry = {
    complete: false,
    readable: ["scope", "contract-quantities"],
    writable: ["scope", "contract-quantities"],
  };
  expect(documentEditorAccess(inquiry, false, "83").writable).toEqual(
    inquiry.writable,
  );
});

test("unsupported financial rules disable price writes while malformed data and cancellation remain errors", async () => {
  const signal = new AbortController().signal;
  const processor = {
    async financial() {
      throw new Error("financial-view-unsupported-pricing");
    },
  };
  expect(
    await checkedFinancialView(processor, "XML", undefined, signal),
  ).toBeNull();
  processor.financial = async () => {
    throw new Error("financial-view-item-total");
  };
  await expect(
    checkedFinancialView(processor, "XML", undefined, signal),
  ).rejects.toThrow("financial-view-item-total");
  const cancelled = new AbortController();
  cancelled.abort(new Error("Financial access revoked"));
  processor.financial = async () => {
    throw new Error("financial-view-unsupported-pricing");
  };
  await expect(
    checkedFinancialView(processor, "XML", undefined, cancelled.signal),
  ).rejects.toThrow("Financial access revoked");
});

test("a cancelled editor view cannot start XML work or publish a late successful validation", async () => {
  const context = new AbortController();
  let finish;
  let calls = 0;
  const processor = {
    updateView() {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const view = documentContentView(
    processor,
    {},
    "offer",
    {
      complete: false,
      readable: ["scope"],
      writable: ["scope"],
    },
    false,
    context.signal,
    () => context.signal.throwIfAborted(),
  );
  const pending = view.validate("visible XML");
  context.abort(new Error("Editor access revoked"));
  finish({});
  await expect(pending).rejects.toThrow("Editor access revoked");
  await expect(view.validate("another XML")).rejects.toThrow(
    "Editor access revoked",
  );
  expect(calls).toBe(1);
});

test("a financial worker result is discarded after cancellation", async () => {
  const context = new AbortController();
  let finish;
  let calls = 0;
  const processor = {
    financial() {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const pending = checkedFinancialView(
    processor,
    "XML",
    undefined,
    context.signal,
  );
  context.abort(new Error("Financial access revoked"));
  finish({ phase: "84", netAmount: "30.00" });
  await expect(pending).rejects.toThrow("Financial access revoked");
  await expect(
    checkedFinancialView(processor, "XML", undefined, context.signal),
  ).rejects.toThrow("Financial access revoked");
  expect(calls).toBe(1);
});

test("worker refusal is a failed partial-view check and never a schema-valid result", async () => {
  const context = new AbortController();
  const processor = {
    async updateView() {
      throw new Error("An unread price reference was changed");
    },
  };
  const view = documentContentView(
    processor,
    {},
    "invoice",
    {
      complete: false,
      readable: ["scope"],
      writable: ["scope"],
    },
    false,
    context.signal,
    () => {},
  );
  expect(await view.validate("tampered XML")).toEqual({
    valid: false,
    issues: [{ message: "An unread price reference was changed" }],
  });
});
