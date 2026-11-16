import {
  browserGaebXml,
  createGaebXml,
  GaebDocument,
  SharedFields,
  initializeSharedField,
} from "@sortsys/gaeb";
import {
  elementContentFacet,
  metadataField,
  metadataFields,
} from "../../../sortsys-gaeb/src/core/fieldBindings";
import { createGaebLiveFixture } from "../../app/lib/data/testing/gaebLiveFixture.mjs";
import { layoutGaebDocument } from "../../../sortsys-gaeb/src/canvas/gaebLayout";

/** A scope reader and an invoice reader see different metadata array offsets.
 * They must nevertheless synchronize the same recipient field. */
export async function metadataBindingScenario() {
  const signal = new AbortController().signal;
  const source = createGaebXml("89", "Schulsanierung", "2026-11-13").replace(
    "<InvoiceRecipient><Address><Name1>…</Name1>",
    "<InvoiceRecipient><Address><Name1>Schulverwaltung 738461</Name1>",
  );
  const partition = await browserGaebXml.partition(source, "invoice", signal);
  const view = await browserGaebXml.render(partition.layout, new Map(), signal);
  const full = new GaebDocument(source, "Rechnung.x89");
  const partial = new GaebDocument(view.xml, "Rechnung.x89");
  const recipient = [...metadataFields(full).values()].find(
    ({ element }) => element.textContent === "Schulverwaltung 738461",
  );
  if (!recipient) {
    throw new Error("Synthetic recipient was not created");
  }
  const other = metadataField(partial, recipient.key);
  if (!other) {
    throw new Error("The same recipient is missing from the scope view");
  }
  const fields = new SharedFields();
  fields.enableFacets();
  const header = [...metadataFields(full).values()].find(
    ({ element }) => element.localName === "InvoiceDate",
  );
  const context = document.createElement("canvas").getContext("2d");
  const layout = layoutGaebDocument(partial, context, {
    locale: "de",
    editable: true,
    documentKind: "invoice",
    contentAccess: {
      complete: false,
      readable: ["scope"],
      writable: ["scope"],
    },
    drafts: new Map(),
    change() {},
    enter() {},
  });
  try {
    fields.acknowledge(partial.source, "Rechnung.x89");
    let privateFieldRejectedBeforeRegistration = false;
    try {
      fields.receiveInitialization(
        header.key,
        "2026-11-13",
        initializeSharedField(header.key, "2026-11-13"),
        "scope",
      );
    } catch {
      privateFieldRejectedBeforeRegistration = true;
    }
    fields.register(layout.fields);
    fields.receiveInitialization(
      recipient.key,
      "Schulverwaltung 738461",
      initializeSharedField(recipient.key, "Schulverwaltung 738461"),
      "scope",
    );
    fields.connect(() => {}, true);
    fields.edit(
      recipient.key,
      "Schulverwaltung 738461",
      "Schulverwaltung aktualisiert",
    );
    const projected = fields.project(source, "Rechnung.x89");
    return {
      sourceHasDifferentOffsets: recipient.index !== other.index,
      sameIdentity: recipient.key === other.key,
      nativeProjectionExact:
        projected ===
        source.replace(
          "Schulverwaltung 738461",
          "Schulverwaltung aktualisiert",
        ),
      scopeOwner: elementContentFacet(full, recipient.element, "invoice"),
      billingOwner: elementContentFacet(full, header.element, "invoice"),
      editorOwner: layout.fields.get(recipient.key)?.facet,
      noPrivateFields: [...layout.fields.values()].every(
        (field) => field.facet === "scope",
      ),
      privateFieldRejectedBeforeRegistration,
    };
  } finally {
    fields.destroy();
  }
}

export async function mixedFacetConnectionScenario() {
  const xml = createGaebXml("89", "Schulsanierung", "2026-11-13");
  const model = new GaebDocument(xml, "Rechnung.x89");
  const date = [...metadataFields(model).values()].find(
    ({ element }) => element.localName === "InvoiceDate",
  );
  const settings = {
    xml,
    readableFacets: ["scope", "billing"],
    extraFields: [
      {
        key: date.key,
        facet: "billing",
        value: "2026-11-13",
        multiline: false,
        editable: true,
        label: "Rechnungsdatum",
        commit() {},
      },
    ],
  };
  const session = await createGaebLiveFixture();
  try {
    const first = session.peer("Kalkulation", "Hallo Welt", settings);
    const second = session.peer("Abrechnung", "Hallo Welt", settings);
    await first.connection.flush();
    await second.connection.flush();
    first.sharedFields.edit(date.key, "2026-11-13", "2026-11-14");
    first.sharedFields.edit("item-a:text:0", "Hallo Welt", "Hallo Baustelle");
    await first.connection.flush();
    await second.connection.flush();
    const late = session.peer("Später Beitritt", "Hallo Welt", settings);
    await late.connection.flush();
    return {
      text: [first, second, late].map((peer) =>
        peer.sharedFields.value("item-a:text:0"),
      ),
      invoice: [first, second, late].map((peer) =>
        peer.sharedFields.value(date.key),
      ),
      nativeDate: new GaebDocument(
        late.sharedFields.project(xml, "Rechnung.x89"),
        "Rechnung.x89",
      )
        .metadataElements()
        .find((element) => element.localName === "InvoiceDate").textContent,
      rejected: [first, second, late].map((peer) => peer.rejected()),
    };
  } finally {
    session.close();
  }
}
