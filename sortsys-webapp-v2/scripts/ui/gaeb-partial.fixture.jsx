import React, { createRef } from "react";
import "@sortsys/gaeb/styles.css";
import {
  browserGaebXml,
  createGaebXml,
  DEFAULT_GAEB_VIEW,
  GaebDocument,
  GaebEditor,
  gaebNetAmount,
} from "@sortsys/gaeb";
import { GAEB_CONTENT_FACETS } from "../../../sortsys-gaeb/src/core/contentFacets";
import { layoutGaebDocument } from "../../../sortsys-gaeb/src/canvas/gaebLayout";
import { checkedFinancialView } from "../../app/lib/data/documentEditor";

const ORIGINAL_TEXT = "Fassadenbeschichtung im Innenhof 843167";
const CHANGED_TEXT = "Überarbeitete Leistungsbeschreibung ohne Preisfreigabe";
const FILE_NAME = "Auftrag.x86";
const KIND = "offer";

export function nativeSource(phase = "86", description = ORIGINAL_TEXT) {
  const item = [
    '<Item ID="item-1" RNoPart="0001">',
    "<Qty>3.125</Qty><QU>m²</QU>",
    ...(phase === "83" ? [] : ["<UP>592.375</UP><IT>1851.17</IT>"]),
    "<Description><CompleteText><DetailTxt><Text>",
    `<p><span>${description}</span></p>`,
    "</Text></DetailTxt></CompleteText></Description>",
    "<!--Unbekannte Herstellerangabe 927461-->",
    "</Item>",
  ].join("");
  return createGaebXml(phase, "Fassadensanierung", "2026-11-13")
    .replace(
      "</GAEBInfo>",
      "</GAEBInfo><PrjInfo><NamePrj>Schulsanierung Nordflügel</NamePrj></PrjInfo>",
    )
    .replace("<BoQBody/>", `<BoQBody><Itemlist>${item}</Itemlist></BoQBody>`);
}

function fragmentsByFacet(fragments) {
  const groups = new Map();
  for (const fragment of fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return groups;
}

export async function openView(
  readAll = false,
  kind = KIND,
  writable = ["scope"],
  readableFacets,
  source = nativeSource(),
) {
  const signal = new AbortController().signal;
  const original = await browserGaebXml.partition(source, kind, signal);
  const schema = await browserGaebXml.validate(
    source,
    original.layout.identity,
    signal,
  );
  if (!schema.valid) {
    throw new Error(JSON.stringify(schema.issues));
  }
  const readable =
    readableFacets ?? (readAll ? [...GAEB_CONTENT_FACETS] : ["scope"]);
  const basis = {
    layout: original.layout,
    fragments: original.fragments.filter((fragment) =>
      readable.includes(fragment.facet),
    ),
  };
  const view = await browserGaebXml.render(
    basis.layout,
    fragmentsByFacet(basis.fragments),
    signal,
  );
  return {
    source,
    kind,
    original,
    basis,
    xml: view.xml,
    access: { complete: view.complete, readable, writable },
  };
}

export async function openReferencedPriceView() {
  const readable = ["scope", "contract-quantities", "offer-prices"];
  const reference = await openView(
    false,
    KIND,
    [],
    readable,
    nativeSource("83"),
  );
  const source = createGaebXml("84", "Fassadensanierung", "2026-11-13").replace(
    "<BoQBody/>",
    [
      '<BoQBody><Itemlist><Item ID="item-1" RNoPart="0001">',
      "<UP>592.375</UP><IT>1851.17</IT>",
      "<!--Unbekannte Herstellerangabe 927461-->",
      "</Item></Itemlist></BoQBody>",
    ].join(""),
  );
  const current = await openView(
    false,
    KIND,
    ["offer-prices"],
    readable,
    source,
  );
  return { current, reference };
}

export async function openUnfinishedPriceView() {
  const related = await openReferencedPriceView();
  function duplicatePosition(source) {
    const first = /<Item\b[\s\S]*?<\/Item>/.exec(source)?.[0];
    if (!first) {
      throw new Error("Expected the financial fixture's first position");
    }
    const second = first
      .replace('ID="item-1"', 'ID="item-2"')
      .replace('RNoPart="0001"', 'RNoPart="0002"');
    return source.replace("</Itemlist>", `${second}</Itemlist>`);
  }
  const readable = ["scope", "contract-quantities", "offer-prices"];
  const current = await openView(
    false,
    KIND,
    ["offer-prices"],
    readable,
    duplicatePosition(related.current.source)
      .replaceAll("<UP>592.375</UP>", "")
      .replaceAll("<IT>1851.17</IT>", ""),
  );
  const reference = await openView(
    false,
    KIND,
    [],
    readable,
    duplicatePosition(related.reference.source),
  );
  return { current, reference };
}

async function updateView(
  current,
  source,
  signal = new AbortController().signal,
) {
  return browserGaebXml.updateView(
    source,
    current.kind,
    current.basis,
    current.access.writable,
    signal,
  );
}

async function reconstructNative(current, updated) {
  const fragments = new Map(
    current.original.fragments.map((fragment) => [fragment.id, fragment]),
  );
  for (const fragment of updated.fragments) {
    fragments.set(fragment.id, fragment);
  }
  const signal = new AbortController().signal;
  const result = await browserGaebXml.render(
    updated.layout,
    fragmentsByFacet([...fragments.values()]),
    signal,
  );
  const schema = await browserGaebXml.validate(
    result.xml,
    updated.layout.identity,
    signal,
  );
  if (!result.complete || !schema.valid) {
    throw new Error(JSON.stringify(schema.issues));
  }
  return result;
}

export async function partialWorkerScenario() {
  const current = await openView();
  const updated = await updateView(
    current,
    current.xml.replace(ORIGINAL_TEXT, CHANGED_TEXT),
  );
  const native = await reconstructNative(current, updated);
  let foreignWritesRejected = false;
  try {
    await updateView(
      current,
      current.xml.replace("</Item>", "<UP>0.000</UP></Item>"),
    );
  } catch {
    foreignWritesRejected = true;
  }
  return {
    complete: current.access.complete,
    secretsAbsent:
      !current.xml.includes("592.375") && !current.xml.includes("3.125"),
    exactNative:
      native.complete &&
      native.xml === current.source.replace(ORIGINAL_TEXT, CHANGED_TEXT),
    foreignWritesRejected,
  };
}

export async function financialWorkerScenario() {
  const current = await openView(
    false,
    KIND,
    ["offer-prices"],
    ["scope", "contract-quantities", "offer-prices"],
  );
  const signal = new AbortController().signal;
  const unsupported = current.xml.replace(
    "</Itemlist>",
    "<MarkupItem/></Itemlist>",
  );
  const missing = current.xml.replace("<Qty>3.125</Qty>", "");
  const legacy = current.xml.replace(
    "http://www.gaeb.de/GAEB_DA_XML/DA86/3.3",
    "http://www.gaeb.de/GAEB_DA_XML/200407",
  );
  let malformedRejected = false;
  try {
    await checkedFinancialView(
      browserGaebXml,
      current.xml.replace("<IT>1851.17</IT>", "<IT>0.00</IT>"),
      undefined,
      signal,
    );
  } catch (error) {
    malformedRejected = error.message === "financial-view-item-total";
  }
  return {
    unsupported: await checkedFinancialView(
      browserGaebXml,
      unsupported,
      undefined,
      signal,
    ),
    missing: await checkedFinancialView(
      browserGaebXml,
      missing,
      undefined,
      signal,
    ),
    legacyAmount: (
      await checkedFinancialView(browserGaebXml, legacy, undefined, signal)
    )?.netAmount,
    malformedRejected,
  };
}

export function printedAmountScenario() {
  const ordinary = nativeSource()
    .replace("<Qty>3.125</Qty>", "<Qty>3.000</Qty>")
    .replace("<UP>592.375</UP>", "<UP>10.000</UP>")
    .replace("<IT>1851.17</IT>", "<IT>30.00</IT>");
  const provisional = ordinary.replace(
    "<Qty>",
    "<Provis>WithoutTotal</Provis><Qty>",
  );
  const lumpSum = ordinary
    .replace("<Qty>3.000</Qty>", "<LumpSumItem>Yes</LumpSumItem>")
    .replace("<IT>30.00</IT>", "<IT>10.00</IT>");
  const noQuantity = ordinary.replace("<Qty>3.000</Qty>", "");
  const noPrice = ordinary.replace("<UP>10.000</UP>", "");
  const model = new GaebDocument(lumpSum, "Pauschale.x86");
  const result = {
    ordinary: gaebNetAmount(ordinary),
    provisional: gaebNetAmount(provisional),
    lumpSum: gaebNetAmount(lumpSum),
    lumpSumItem: model.amount(model.items[0]),
    noQuantity: gaebNetAmount(noQuantity),
    noPrice: gaebNetAmount(noPrice),
    provisionalNoPrice: gaebNetAmount(
      provisional.replace("<UP>10.000</UP>", ""),
    ),
    sourceUnchanged: model.source === lumpSum,
  };
  return result;
}

export async function mountPartialEditor(
  root,
  { readAll = false, kind = KIND, writable = ["scope"] } = {},
) {
  const current = await openView(readAll, kind, writable);
  const editor = createRef();
  const calls = [];
  const changes = [];
  const cache = new Map();
  const contentView = {
    access: current.access,
    async validate(source, signal) {
      try {
        await updateView(current, source, signal);
        return { valid: true, issues: [] };
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        return { valid: false, issues: [{ message: error.message }] };
      }
    },
  };
  function layout(access = current.access) {
    return layoutGaebDocument(
      new GaebDocument(current.xml, FILE_NAME),
      document.createElement("canvas").getContext("2d"),
      {
        locale: "de",
        editable: true,
        documentKind: current.kind,
        contentAccess: access,
        drafts: new Map(),
        change: (operation) => changes.push(operation),
        enter() {},
        cache,
      },
    );
  }
  window.gaebPartialFixture = {
    ready: () => Boolean(editor.current),
    save: () => editor.current.save(),
    calls: () => calls,
    original: () => current.source,
    expected: () => current.source.replace(ORIGINAL_TEXT, CHANGED_TEXT),
    description: CHANGED_TEXT,
    restrict() {
      current.access = {
        complete: false,
        readable: ["scope"],
        writable: ["scope"],
      };
      render();
    },
    layout() {
      const rendered = layout();
      return {
        fields: [...rendered.fields.values()].map(
          ({ key, editable, value }) => ({ key, editable, value }),
        ),
        text: rendered.pages
          .flatMap((page) => page.commands)
          .filter((command) => command.kind === "text")
          .map((command) => command.text)
          .join(" "),
      };
    },
    deniedCommits() {
      const rendered = layout();
      for (const field of rendered.fields.values()) {
        if (!field.editable) {
          field.commit("0.000");
        }
      }
      return changes.length;
    },
  };
  function render() {
    root.render(
      <div style={{ height: "100vh" }}>
        <GaebEditor
          xml={current.xml}
          fileName={FILE_NAME}
          documentKind={current.kind}
          canEdit
          locale="de"
          contentView={{ ...contentView, access: current.access }}
          editorRef={editor}
          viewPreferences={DEFAULT_GAEB_VIEW}
          onSave={async (source) => {
            const updated = await updateView(current, source);
            const native = await reconstructNative(current, updated);
            calls.push({ source, native: native.xml });
            return source;
          }}
        />
      </div>,
    );
  }
  render();
}
