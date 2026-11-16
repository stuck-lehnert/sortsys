import React, { createRef } from "react";
import {
  createGaebXml,
  DEFAULT_GAEB_VIEW,
  GAEB_CONTENT_FACETS,
  GaebEditor,
  initializeSharedField,
  SharedFields,
} from "@sortsys/gaeb";
import signedOffer from "../../../sortsys-gaeb/src/core/fixtures/signed-offer.x84?raw";
import { connectProtectedGaebLive } from "../../app/lib/data/gaebLive";
import { Observable } from "rxjs";
import { createRoot } from "react-dom/client";
import GaebFileModal from "../../app/components/GaebFileModal";
import { client, gaebDocuments, templateAssets } from "../../app/lib/client";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { I18nProvider } from "../../app/lib/i18n";
import { documentContentView } from "../../app/lib/data/documentEditor";
import { documentEditorAccess } from "../../app/lib/data/documentEditor";
import { browserGaebXml } from "@sortsys/gaeb";

export function mountPublicationModal({
  initialContent,
  documentKind,
  positions = { scope: "7" },
} = {}) {
  const editor = createRef();
  const calls = [];
  const revisions = [];
  const xml =
    initialContent?.xml ?? createGaebXml("84", "Altauftrag", "2026-11-12");
  let content = {
    xml,
    frozen: false,
    referenceXml: null,
    fileName: "Angebot.x84",
    version: 1n,
    canEdit: true,
    liveTicket: "",
    livePath: "",
    recoveryScope: "",
    ...initialContent,
  };
  let fields;
  let subscriber;
  let rejectSharedMessage;
  client.query = async (path) => {
    if (path === "personalization.gaebView.get") {
      return [DEFAULT_GAEB_VIEW, null];
    }
    if (path === "commercial.documents.get") {
      return [content, null];
    }
    if (path === "settings.documentTemplate.get") {
      return [{ source: null, revision: "0", assets: [] }, null];
    }
    if (path === "settings.organization.get") {
      return [
        {
          companyName: "Lehnert Musterbau GmbH",
          address: {
            streetAddress: "Bauhofstraße 12",
            zip: "90402",
            city: "Nürnberg",
            country: "Deutschland",
          },
        },
        null,
      ];
    }
    throw new Error(`Unexpected modal query: ${path}`);
  };
  client.mutate = async (path, input) => {
    if (path !== "commercial.documents.save") {
      throw new Error(`Unexpected modal mutation: ${path}`);
    }
    calls.push(input);
    return [{ version: content.version, savedAt: new Date() }, null];
  };
  gaebDocuments.open = async () => content;
  client.streamQuery = () =>
    new Observable((listener) => {
      subscriber = listener;
      listener.next([null, null]);
    });
  gaebDocuments.live = async (options) => {
    fields = options.sharedFields;
    rejectSharedMessage = options.onRejectedMessage;
    return {
      field() {},
      selection() {},
      saved() {},
      async flush() {
        return positions;
      },
      close() {},
    };
  };
  window.gaebPublicationModal = {
    ready: () => Boolean(editor.current && fields),
    save: () => editor.current.save(),
    requestClose: () => editor.current.requestClose(),
    calls: () => calls,
    revisions: () => revisions,
    async pdfText(bytes, renderPage = false) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
      const task = pdfjs.getDocument({
        data: Uint8Array.from(bytes),
        useSystemFonts: false,
      });
      try {
        const pdf = await task.promise;
        const texts = [];
        let images = 0;
        let png;
        for (let index = 1; index <= pdf.numPages; index++) {
          const page = await pdf.getPage(index);
          texts.push(
            (await page.getTextContent()).items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" "),
          );
          const operators = await page.getOperatorList();
          images += operators.fnArray.filter((operation) =>
            [
              pdfjs.OPS.paintImageXObject,
              pdfjs.OPS.paintInlineImageXObject,
            ].includes(operation),
          ).length;
          if (renderPage && index === 1) {
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await page.render({
              canvas,
              canvasContext: canvas.getContext("2d"),
              viewport,
            }).promise;
            png = canvas.toDataURL("image/png").split(",")[1];
          }
          page.cleanup();
        }
        return { text: texts.join("\n"), pages: pdf.numPages, images, png };
      } finally {
        await task.destroy();
      }
    },
    rejectSharedMessage() {
      rejectSharedMessage?.();
    },
    draft() {
      fields.receive(
        initializeSharedField(
          "project:title",
          "Ungespeicherter Entwurf 821947",
        ),
      );
    },
    finalize() {
      content = {
        ...content,
        xml: xml.replaceAll("Altauftrag", "Endauftrag"),
        version: 2n,
        frozen: true,
        canEdit: false,
      };
      subscriber.next([null, null]);
    },
    exactNative: () =>
      fields.project(content.xml, content.fileName) === content.xml,
  };
  const host = window.document.createElement("div");
  window.document.body.append(host);
  createRoot(host).render(
    <I18nProvider>
      <GaebFileModal
        caseId="2"
        documentId="3"
        fileName="Angebot.x84"
        documentKind={documentKind}
        onSaved={(revision) => revisions.push(revision)}
        workspaceRef={editor}
      />
    </I18nProvider>,
  );
}

export async function mountPartialPublicationModal() {
  const { openView } = await import("./gaeb-partial.fixture.jsx");
  const partial = await openView();
  const signal = new AbortController().signal;
  mountPublicationModal({
    documentKind: partial.kind,
    initialContent: {
      xml: partial.xml,
      fileName: "Auftrag.x86",
      contentView: documentContentView(
        browserGaebXml,
        partial.basis,
        partial.kind,
        partial.access,
        false,
        signal,
        () => signal.throwIfAborted(),
      ),
    },
  });
}

export async function mountFinancialPublicationModal({
  referenced = false,
  image,
  unfinished = false,
  quantityWriter = false,
} = {}) {
  const { openView, openReferencedPriceView, openUnfinishedPriceView } =
    await import("./gaeb-partial.fixture.jsx");
  let current;
  let referenceXml;
  let referencePartition;
  if (referenced) {
    const related = unfinished
      ? await openUnfinishedPriceView()
      : await openReferencedPriceView();
    current = related.current;
    referenceXml = related.reference.xml;
    referencePartition = related.reference.basis;
  } else {
    current = await openView(
      false,
      "offer",
      quantityWriter ? ["contract-quantities"] : ["offer-prices"],
      ["scope", "contract-quantities", "offer-prices"],
    );
  }
  if (image) {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 80;
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = "#cbdcf5";
    drawing.fillRect(0, 0, 160, 80);
    drawing.strokeStyle = "#1e4774";
    drawing.strokeRect(4, 4, 152, 72);
    drawing.fillStyle = "#13283e";
    drawing.font = "16px sans-serif";
    drawing.fillText("Fensterdetail", 24, 44);
    const data = canvas.toDataURL("image/png").split(",")[1];
    const imageElement = `<image Type="image/png" Encoding="base64" width="160">${data}</image>`;
    const readable = ["scope", "contract-quantities", "offer-prices"];
    if (image === "readable") readable.push("attachment");
    current = await openView(
      false,
      "offer",
      ["offer-prices"],
      readable,
      current.source.replace("</p>", `${imageElement}</p>`),
    );
  }
  const signal = new AbortController().signal;
  templateAssets.context = () => signal;
  const financial = await browserGaebXml.financial(
    current.xml,
    referenceXml,
    signal,
  );
  const expectedAmount = unfinished ? null : "1851.17";
  if (financial.netAmount !== expectedAmount) {
    throw new Error("Unexpected financial fixture");
  }
  current.access = documentEditorAccess(
    current.access,
    true,
    referenced ? "84" : "86",
  );
  const printContext = {
    reference: referencePartition,
    needsReference: referenced,
  };
  const printAssessment = await browserGaebXml.assessPrint(
    {
      source: current.xml,
      kind: "offer",
      basis: current.basis,
      writable: current.access.writable,
      ...printContext,
    },
    signal,
  );
  let availablePrintContext;
  if (
    printAssessment.status === "ready" ||
    printAssessment.status === "incomplete-pricing"
  ) {
    availablePrintContext = {
      ...printContext,
      readiness: printAssessment.status,
    };
  }
  mountPublicationModal({
    documentKind: "offer",
    positions: quantityWriter
      ? { "contract-quantities": "7" }
      : { "offer-prices": "7" },
    initialContent: {
      xml: current.xml,
      referenceXml,
      fileName: referenced ? "Angebot.x84" : "Auftrag.x86",
      contentView: documentContentView(
        browserGaebXml,
        current.basis,
        "offer",
        current.access,
        false,
        signal,
        () => signal.throwIfAborted(),
        availablePrintContext,
        referenceXml,
      ),
    },
  });
}

export async function mountSignedPublicationModal() {
  const signal = new AbortController().signal;
  templateAssets.context = () => signal;
  const basis = await browserGaebXml.partition(signedOffer, "offer", signal);
  const referenceXml = createGaebXml(
    "83",
    "Fensterarbeiten",
    "2026-11-13",
  ).replace(
    "<BoQBody/>",
    '<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><Qty>3.000</Qty><QU>m²</QU><Description><CompleteText><DetailTxt><Text><p><span>Fensterlaibungen verputzen</span></p></Text></DetailTxt></CompleteText></Description></Item></Itemlist></BoQBody>',
  );
  const reference = await browserGaebXml.partition(
    referenceXml,
    "offer",
    signal,
  );
  const access = {
    complete: true,
    readable: [...GAEB_CONTENT_FACETS],
    writable: [],
    pricingSupported: true,
  };
  const printContext = { reference, needsReference: true };
  const assessment = await browserGaebXml.assessPrint(
    {
      source: signedOffer,
      kind: "offer",
      basis,
      writable: [],
      ...printContext,
    },
    signal,
  );
  if (assessment.status !== "ready") {
    throw new Error("The signed fixture must be printable");
  }
  mountPublicationModal({
    documentKind: "offer",
    initialContent: {
      xml: signedOffer,
      referenceXml,
      fileName: "Signiertes Angebot.x84",
      frozen: true,
      canEdit: false,
      contentView: documentContentView(
        browserGaebXml,
        basis,
        "offer",
        access,
        false,
        signal,
        () => signal.throwIfAborted(),
        { ...printContext, readiness: assessment.status },
        referenceXml,
      ),
    },
  });
}

export function mountPublicationEditor(root) {
  const editor = createRef();
  const calls = [];
  let held = false;
  const pending = [];
  const xml = createGaebXml("84", "Bestätigter Dokumentstand", "2026-11-12");
  window.gaebPublicationFixture = {
    ready: () => Boolean(editor.current),
    save: () => editor.current.save(),
    calls: () => calls,
    pause() {
      held = true;
    },
    release() {
      held = false;
      for (const finish of pending.splice(0)) finish();
    },
  };
  root.render(
    <GaebEditor
      xml={xml}
      fileName="Angebot.x84"
      canEdit
      locale="de"
      viewPreferences={DEFAULT_GAEB_VIEW}
      editorRef={editor}
      onSave={async (source, base) => {
        calls.push({ source, base });
        if (held) await new Promise((resolve) => pending.push(resolve));
        return source;
      }}
    />,
  );
}

export async function frozenPublicationScenario() {
  const xml = createGaebXml("84", "Abgeschlossener Auftrag", "2026-11-12");
  const fields = new SharedFields();
  const historicalText = initializeSharedField(
    "project:title",
    "Veralteter Live-Entwurf",
  );
  let requests = 0;
  const transport = {
    query() {
      requests += 1;
      throw new Error("Final files must not read historical room text");
    },
    mutate() {
      requests += 1;
      throw new Error("Final files must not post room text");
    },
  };
  fields.acknowledge(xml, "Angebot.x84");
  fields.register(
    new Map([
      [
        "project:title",
        {
          key: "project:title",
          value: "Abgeschlossener Auftrag",
          multiline: false,
          editable: true,
          label: "Bauvorhaben",
          commit() {},
        },
      ],
    ]),
  );
  fields.receive(historicalText);
  const before = fields.project(xml, "Angebot.x84");
  const connection = connectProtectedGaebLive(transport, {
    room: { scope: "commercial:2", document: "3" },
    initial: {
      xml,
      fileName: "Angebot.x84",
      version: 2n,
      canEdit: false,
      frozen: true,
    },
    sharedFields: fields,
    signal: new AbortController().signal,
    name: "Leserin",
    onStatus() {},
    onParticipants() {},
  });
  try {
    await connection.flush();
    fields.receive(historicalText);
    fields.edit(
      "project:title",
      "Abgeschlossener Auftrag",
      "Unerlaubter späterer Text",
    );
    return {
      hadOverlay: before !== xml,
      exactNative: fields.project(xml, "Angebot.x84") === xml,
      canUndo: fields.canUndo("undo"),
      requests,
    };
  } finally {
    connection.close();
    fields.destroy();
  }
}
