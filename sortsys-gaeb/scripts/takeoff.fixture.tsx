import seedTakeoff from "./fixtures/native-seed/demo.x31?raw";
import seedContract from "./fixtures/native-seed/demo.x86?raw";
import { createRoot } from "react-dom/client";
import {
  GaebEditor,
  GaebDocument,
  createGaebXml,
  deriveGaebDocument,
  newMeasurement,
} from "../src/index";
import "../src/standalone.css";

const update = (doc: GaebDocument, source: string) =>
  new GaebDocument(source, doc.fileName);
let reference = new GaebDocument(
  createGaebXml("86", "Fenstersanierung Westflügel"),
  "Auftrag.x86",
);
reference = update(reference, reference.setProjectName("Fenstersanierung Westflügel"));
for (const [title, unit] of [
  ["Fensterleibungen verputzen", "m²"],
  ["Anschlussfugen herstellen", "m"],
  ["Gerüstfläche / Standzeit", "m²"],
]) {
  reference = update(reference, reference.addItem());
  const item = reference.items.at(-1)!;
  reference = update(reference, reference.setRichGroupText(item, 0, title));
  reference = update(
    reference,
    reference.setValue(reference.items.at(-1)!, "QU", unit),
  );
  reference = update(
    reference,
    reference.setValue(reference.items.at(-1)!, "Qty", "150.000"),
  );
}
for (const [role, name, street, city] of [
  ["OWN", "Stadtbauamt Musterstadt", "Rathausplatz 7", "Musterstadt"],
  ["CTR", "Musterbau GmbH", "Gewerbestraße 12", "Beispielstadt"],
]) {
  const address = reference.child(
    reference.xml.getElementsByTagNameNS(reference.namespace, role)[0],
    "Address",
  )!;
  const indices = reference
    .metadataElements()
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.parentElement === address);
  for (const { element, index } of indices)
    reference = update(
      reference,
      reference.setMetadata(
        index,
        (
          { Name1: name, Street: street, PCode: "90400", City: city } as Record<
            string,
            string
          >
        )[element.localName] ??
          element.textContent ??
          "",
      ),
    );
}
let measured = new GaebDocument(
  deriveGaebDocument(reference.source, "31", {
    title: "Aufmaß Westflügel · November",
  }),
  "Aufmaß.x31",
);
for (const row of [
  {
    ...newMeasurement("area", "wall"),
    location: "Westflügel · EG",
    label: "Fensterleibung Raum 01",
    a: "1.455",
    b: "1.535",
    count: "4",
  },
  {
    ...newMeasurement("area", "window"),
    location: "Westflügel · EG",
    label: "Fensteröffnung",
    a: "1.2",
    b: "1.5",
    count: "4",
    mode: "opening" as const,
    threshold: "2.5",
  },
  {
    ...newMeasurement("factor", "arch"),
    location: "Westflügel · 1. OG",
    label: "Bogen über Fensterelement",
    a: "0.3",
    b: "1.83",
    count: "4",
    factor: "0.67",
  },
])
  measured = update(measured, measured.addMeasurement(measured.items[0], row));
measured = update(
  measured,
  measured.addMeasurement(measured.items[1], {
    ...newMeasurement("length", "joints"),
    location: "Westflügel · EG",
    label: "Senkrechte Anschlussfugen",
    a: "1.455",
    count: "8",
  }),
);
measured = update(
  measured,
  measured.addMeasurement(measured.items[2], {
    ...newMeasurement("volume", "scaffold"),
    location: "Westfassade",
    label: "Gerüst mit Standzeitfaktor",
    a: "12",
    b: "5",
    c: "4",
  }),
);
const seedExample = new URLSearchParams(location.search).has("seed");
const storageKey = seedExample ? "takeoff-seed-fixture" : "takeoff-fixture";
const referenceXml = seedExample ? seedContract : reference.source;
const startingXml =
  sessionStorage.getItem(storageKey) ??
  (seedExample ? seedTakeoff : measured.source);
(window as any).__takeoffXml = startingXml;
(window as any).__takeoffReference = referenceXml;
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <div
      style={{
        padding: "10px 20px",
        fontWeight: 600,
        borderBottom: "1px solid #ddd",
      }}
    >
      {seedExample
        ? "Aufmaß · Musterauftrag"
        : "Aufmaß · Fenstersanierung Westflügel"}
    </div>
    <GaebEditor
      xml={startingXml}
      fileName="Aufmaß.x31"
      referenceXml={referenceXml}
      canEdit
      locale="de"
      onSave={async (xml) => {
        (window as any).__takeoffXml = xml;
        sessionStorage.setItem(storageKey, xml);
      }}
    />
  </div>,
);
