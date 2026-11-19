import { expect, test } from "bun:test";
import { buildPrefixSearch, createPrefixMatcher } from "./prefixQuery.ts";

// Results of the former create_query SQL function on PostgreSQL 18.6.
const entries = [
  {
    id: "Verbund",
    fields: ["4711", "Systemprofil", "WDVS-System EN-ISO-9001"],
  },
  {
    id: "Getrennt",
    fields: ["4721", "WDVS Anschluss", "Systembügel"],
  },
  {
    id: "Umgekehrt",
    fields: ["4888", "System für WDVS", "Anschluss"],
  },
  {
    id: "Kennung",
    fields: ["12", "D-123 A-24z", "Kalk_Mörtel UV–beständig"],
  },
  {
    id: "Menge",
    fields: ["16", "D 123 A 24z", "Kalk weißer Mörtel UV beständig"],
  },
  {
    id: "Netzadresse",
    fields: ["26", "Details", "https://shop.beispiel.de/putz-201.pdf?farbe=weiss"],
  },
  {
    id: "LokalerPfad",
    fields: ["28", "Details", "/Dateien/Fuge.txt Keller/Wand"],
  },
  {
    id: "Dateiname",
    fields: ["29", "Montage.pdf", "Datenblatt"],
  },
  {
    id: "E-Mail",
    fields: ["32", "Montage", "Meier.Bau@beispiel.de"],
  },
  {
    id: "Maß",
    fields: ["48", "Mörtel", "3.50 6e-4 +42"],
  },
  {
    id: "Komma",
    fields: ["49", "Mörtel", "3,50 -42"],
  },
  {
    id: "Text",
    fields: ["61", "Arbeitsbericht", "<b>Fuge &amp; Wand</b> D'Artagnan"],
  },
];

const cases = [
  ["wdvs-sys", ["Verbund"]],
  ["WDVS Sys", ["Verbund", "Getrennt", "Umgekehrt"]],
  ["SyStem WDVS", ["Verbund", "Getrennt", "Umgekehrt"]],
  ["471 Pro", []],
  ["471 Sys", ["Verbund"]],
  ["9001", ["Verbund"]],
  ["-9001", []],
  ["D-12", ["Kennung"]],
  ["D 12", ["Kennung", "Menge"]],
  ["24z", ["Kennung", "Menge"]],
  ["A-24", []],
  ["A-24z", ["Kennung"]],
  ["Kalk_Mör", ["Kennung"]],
  ["Kalk Mö", ["Kennung", "Menge"]],
  ["UV–bes", ["Kennung", "Menge"]],
  ["UV-bes", []],
  ["UV best", ["Kennung", "Menge"]],
  ["https://shop.beispiel.de/putz", ["Netzadresse"]],
  ["shop.beispiel.de/putz", ["Netzadresse"]],
  ["/putz-201", ["Netzadresse"]],
  ["putz-201", []],
  ["shop.beispiel.de", ["Netzadresse"]],
  ["beispiel.de", []],
  ["farbe", []],
  ["/Dateien/Fu", ["LokalerPfad"]],
  ["Wand", ["Text"]],
  ["Keller/Wa", ["LokalerPfad"]],
  ["Montage.p", ["Dateiname"]],
  ["pdf", []],
  ["Meier.Bau@", ["E-Mail"]],
  ["Meier.Bau@beisp", []],
  ["3.5", ["Maß"]],
  ["3,5", ["Komma"]],
  ["6e-4", ["Maß"]],
  ["+42", ["Maß"]],
  ["-42", ["Komma"]],
  ["Mörtel", ["Kennung", "Menge", "Maß"]],
  ["Mört", ["Komma"]],
  ["Fuge\tWand", ["Text"]],
  ["Fuge / Wand", ["Text"]],
  ["Fuge---Wand", ["Text"]],
  ["D'Art", ["Text"]],
  ["amp", []],
  ["Fenster ---", []],
  ["---", []],
];

const searchCatalogue = buildPrefixSearch(entries, ({ fields }) => fields);

test.each(cases)("matches the reference catalogue for %j", (query, expected) => {
  const matches = createPrefixMatcher(query);
  const hits = entries.filter(({ fields }) => matches(fields));
  expect(hits.map(({ id }) => id)).toEqual(expected);
  expect(searchCatalogue(query).map(({ id }) => id)).toEqual(expected);
});

test("returns the first eligible matches, including terms from descriptions", () => {
  const search = buildPrefixSearch(entries, ({ fields }) => fields);
  const hits = search("WDVS", ({ id }) => id !== "Verbund", 1);
  expect(hits.map(({ id }) => id)).toEqual(["Getrennt"]);
  hits[0].fields[2] = "Verändert";
  expect(search("Systembügel", undefined, 1)[0].fields[2]).toBe("Systembügel");
  expect(search("WDVS", undefined, 1).map(({ id }) => id)).toEqual(["Verbund"]);
});

test("distinguishes a blank query from a query without searchable words", () => {
  expect(createPrefixMatcher(null)([])).toBe(true);
  expect(createPrefixMatcher("   ")(["Farbe"])).toBe(true);
  expect(createPrefixMatcher("…")(["Farbe"])).toBe(false);
});
