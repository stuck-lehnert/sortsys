import { execFileSync } from "node:child_process";
import { timestampMicros } from "../../app/lib/data/timestamps";
import {
  compareRankedDocuments,
  createDocumentMatcher,
  matchDocuments,
} from "../../app/lib/search/documentQuery";

// Only synthetic text is sent to PostgreSQL. The query uses the same vector,
// expression and rank ordering as master; the encrypted API is not involved.
const referenceDocuments = [
  { id: "1", name: "Angebot.pdf", text: "Stahl Tor Lieferung" },
  { id: "2", name: "Torplan.pdf", text: "Tor und Stahl" },
  { id: "3", name: "Positionen.pdf", text: "Stahl und Tor" },
  { id: "4", name: "Hinweise.pdf", text: "Stahl und Beton, https://beispiel.test/tor" },
  { id: "5", name: "Notiz.pdf", text: "Nur Beton" },
  { id: "6", name: "Beton Stahl.pdf", text: null },
  { id: "7", name: "Maße.pdf", text: "Übermaß auf der Baustelle. The estimate was approved." },
  { id: "8", name: "Vermerk.pdf", text: "Ｖｅｒｔｒａｇ geprüft." },
  { id: "9", name: "Aufmaß.pdf", text: "Details unter https://daten.bau.test:8443/mengen?version=7" },
  { id: "10", name: "Abnahme.pdf", text: "Kontakt Bauleitung.West@beispiel.test. Danach folgt der Termin." },
  { id: "11", name: "info@nachtrag.test.pdf", text: null },
  { id: "12", name: "Verputz.pdf", text: "Maus. Painting is in progress." },
  { id: "13", name: "Baustelle.pdf", text: "Maus. Painted walls were inspected." },
  { id: "14", name: "Sichtprüfung.pdf", text: "Fenster mit einer Maus im Keller." },
  {
    id: "30", name: "Datum.pdf", text: "Schallschutzglas",
    modifiedAt: "2026-02-01T00:00:00.123002Z",
  },
  {
    id: "31", name: "Links.pdf", text: "Schallschutzglas",
    modifiedAt: "2026-02-01T00:00:00.123001Z",
  },
  {
    id: "32", name: "Rechts.pdf", text: "Schallschutzglas",
    modifiedAt: "2026-02-01T01:00:00.123001+01:00",
  },
  { id: "40", name: "Werkstatt.pdf", text: "Geländer-Anschluss sichern" },
  { id: "41", name: "Kontrolle.pdf", text: "Geländer Anschluss prüfen" },
  { id: "42", name: "Notiz.pdf", text: "Alte Geländer sichern" },
  { id: "43", name: "Bestand.pdf", text: "İnventar ΟΣ" },
  { id: "44", name: "Mörtel.pdf", text: null },
  { id: "45", name: "mörtel12.pdf", text: null },
  { id: "46", name: "Abnahme.über.pdf", text: null },
  { id: "47", name: "Mörtel.2026.pdf", text: null },
  { id: "48", name: "Anmerkung.pdf", text: "Planung=-/planung/halle.dwg." },
  { id: "49", name: "Entwurf.pdf", text: "Planung halle.dwg" },
  { id: "50", name: "Archiv.pdf", text: "vorentwurf-/halle.dwg" },
  { id: "51", name: "Grundriss.pdf", text: "/vorentwurf-/halle.dwg" },
];
const referenceQueries = [
  '"Stahl Tor"',
  '"Stahl und Tor"',
  "Stahl -Beton",
  "Stahl OR Beton",
  "Stah",
  "https://beispiel.test/tor",
  "beispiel.test",
  "/tor",
  '"beispiel.test /tor"',
  "https://daten.bau.test:8443/mengen?version=7",
  "daten.bau.test:8443",
  "mengen",
  "Bauleitung.West@beispiel.test",
  "Bauleitung.West",
  '"bauleitung.west@beispiel.test danach"',
  "info@nachtrag.test.pdf",
  "nachtrag.test.pdf",
  "Mäuse painted",
  "Mäuse painting",
  "painted",
  "Fenster -Mäuse",
  "Übermaß",
  "U\u0308bermaß",
  "Vertrag",
  "Ｖｅｒｔｒａｇ",
  '"estimate was approved"',
  "Schallschutzglas",
  "Geländer-Anschluss",
  '"Geländer-Anschluss"',
  "Geländer --Anschluss",
  "inventar",
  "οσ",
  "ος",
  "Mörtel",
  "Mörtel.pdf",
  "mörtel12.pdf",
  "2026.pdf",
  "Über",
  "/planung/halle.dwg",
  "Planung=-/planung/halle.dwg",
  "/halle.dwg",
];

const stopWordDocuments = [
  { id: "15", name: "Vermessung.pdf", text: "Blenden an den Fenstern der Halle prüfen." },
  { id: "16", name: "Kontrolle.pdf", text: "Blenden an den Fenstern der alten Halle prüfen." },
  { id: "17", name: "Survey.pdf", text: "Seal painted doors before final inspection." },
  { id: "18", name: "Checklist.pdf", text: "Sealing doors before final inspection." },
  { id: "19", name: "Lager.pdf", text: "Bolzen an beschädigten Geländern prüfen." },
];
const stopWordQueries = [
  "und Geländer",
  '"Fenster und Halle"',
  '"sealing the doors"',
  'inspection -"seal the doors"',
  "Geländer -und",
];

const webSyntaxQueries = [
  "Geländer (-Anschluss)",
  "Geländer(-Anschluss)",
  "Geländer (-(Anschluss))",
  "Geländer (-(-Anschluss))",
  "Geländer,-Anschluss",
  "Geländer (Tor OR Beton)",
  "Geländer OR(Anschluss)",
  'Geländer OR"Anschluss"',
  "Geländer OR!Anschluss",
  "Geländer OR-Anschluss",
  "Geländer OR_Anschluss",
  "Geländer!OR Anschluss",
  "Geländer&OR Anschluss",
  "Geländer!-Anschluss",
  "Geländer&-Anschluss",
];

const stopWordProbe = process.argv.includes("--probe-stop-words");
const webSyntaxProbe = process.argv.includes("--probe-web-syntax");
const queries = stopWordProbe
  ? stopWordQueries
  : webSyntaxProbe ? webSyntaxQueries : referenceQueries;
const documents = (stopWordProbe ? stopWordDocuments : referenceDocuments)
  .map((document) => ({ modifiedAt: "2026-01-01T00:00:00Z", ...document }));

function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

const sql = `
SET standard_conforming_strings = on;
WITH documents AS (
  SELECT id::bigint, name, text, "modifiedAt" FROM json_to_recordset(
    ${literal(JSON.stringify(documents))}
  ) AS document(id text, name text, text text, "modifiedAt" timestamptz)
), vectors AS (
  SELECT id, "modifiedAt",
    setweight(to_tsvector('simple', name), 'A')
    || setweight(to_tsvector('german', coalesce(text, '')), 'B')
    || setweight(to_tsvector('english', coalesce(text, '')), 'B') AS vector
  FROM documents
), queries AS (
  SELECT query, ordinality,
    websearch_to_tsquery('german', query)
    || websearch_to_tsquery('english', query)
    || plainto_tsquery('simple', query) AS expression
  FROM unnest(ARRAY[${queries.map(literal).join(", ")}]) WITH ORDINALITY AS entry(query, ordinality)
)
SELECT json_agg(json_build_object('query', query, 'master', ARRAY(
  SELECT id::text FROM vectors WHERE vector @@ expression
  ORDER BY ts_rank_cd(vector, expression) DESC, "modifiedAt" DESC, id DESC
)) ORDER BY ordinality)
FROM queries;
`;

const oracle: { query: string; master: string[] }[] = JSON.parse(
  execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    timeout: 30_000,
  }),
);

const localDocuments = documents.map(({ id, name, text }) => ({
  id: BigInt(id).toString(32), name, text,
}));
const reference = new Map(documents.map(({ id, modifiedAt }) => [
  BigInt(id).toString(32),
  { id, modifiedAtMicros: timestampMicros(modifiedAt) },
]));

const results = oracle.map(({ query, master }) => {
  const zerotrust = matchDocuments(createDocumentMatcher(query), localDocuments)
    .map((match) => ({
      ...match,
      modifiedAtMicros: reference.get(match.id)!.modifiedAtMicros,
    }))
    .sort(compareRankedDocuments)
    .map(({ id }) => reference.get(id)!.id);

  const sameHits =
    master.length === zerotrust.length && master.every((id) => zerotrust.includes(id));
  return { query, master, zerotrust, sameHits, matches: master.join() === zerotrust.join() };
});

console.log(JSON.stringify(results, null, 2));
if (process.argv.includes("--require-parity") && results.some(({ matches }) => !matches)) {
  process.exitCode = 1;
}
if (process.argv.includes("--require-hit-parity") && results.some(({ sameHits }) => !sameHits)) {
  process.exitCode = 1;
}
