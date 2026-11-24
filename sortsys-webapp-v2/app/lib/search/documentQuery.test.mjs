import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compareRankedDocuments,
  createDocumentMatcher,
  createDocumentTokenizer,
} from "./documentQuery";
import { createDocumentSearch } from "./documentSearch";
import { timestampMicros } from "../data/timestamps";
import { DocumentExcerpt } from "../../components/DocumentExcerpt";

const find = (query, body, name = "Ausführung.pdf") =>
  createDocumentMatcher(query).match(name, body);

test("equal document ranks sort by modification microsecond, then highest numeric file ID", () => {
  const earlier = timestampMicros("2026-01-01T00:00:00.123001Z");
  const later = timestampMicros("2026-01-01T01:00:00.123002+01:00");
  const matches = [
    { id: "v", rank: 1, modifiedAtMicros: earlier },
    { id: "u", rank: 1, modifiedAtMicros: later },
    { id: "10", rank: 1, modifiedAtMicros: earlier },
    { id: "1", rank: 2, modifiedAtMicros: earlier },
  ];

  expect(matches.sort(compareRankedDocuments).map(({ id }) => id)).toEqual([
    "1", "u", "10", "v",
  ]);
});

test("German and English inflections are searched locally", () => {
  expect(find("Wand", "Die Wände werden gestrichen.")).not.toBeNull();
  expect(find("Maus", "Mäuse wurden im Keller festgestellt.")).not.toBeNull();
  expect(
    find("install", "Installed windows passed inspection."),
  ).not.toBeNull();
  expect(find("Fenster Rechnung", "Fenster werden eingebaut.")).toBeNull();
});

test("dictionary stop words leave interior phrase distances but do not anchor an edge", () => {
  const german = "Blenden an den Fenstern der Halle prüfen.";
  expect(find('"Fenster und Halle"', german)).not.toBeNull();
  expect(find('"und Fenster"', german)).not.toBeNull();
  expect(find('"Halle und"', german)).not.toBeNull();
  expect(find('"Fenster und Halle"', "Fenstern der alten Halle")).toBeNull();

  const english = "Seal painted doors before final inspection.";
  expect(find('"sealing the doors"', english)).not.toBeNull();
  expect(find('"sealing the doors"', "Sealing doors before inspection.")).toBeNull();
});

test("a removed stop operand does not reject the rest of a clause", () => {
  const text = "Bolzen an beschädigten Geländern prüfen.";
  expect(find("und Geländer", text)).not.toBeNull();
  expect(find("Geländer -und", text)).not.toBeNull();
  expect(find("und", null, "Fenster und Türen.pdf")).not.toBeNull();
});

test("hyphenated compounds are indexed alongside their individual parts", () => {
  const compound = "Geländer-Anschluss sichern";
  const separated = "Geländer Anschluss prüfen";

  for (const query of ["Geländer-Anschluss", '"Geländer-Anschluss"']) {
    const match = find(query, compound);
    expect(match.excerpt.highlights).toEqual([{ start: 0, end: 18 }]);
    expect(find(query, separated)).toBeNull();
  }

  expect(find("Anschluss", compound).excerpt.highlights).toEqual([
    { start: 9, end: 18 },
  ]);
  expect(find("Geländer Anschluss", separated)).not.toBeNull();
});

test("an AND branch cannot mix query stems from different dictionaries", () => {
  expect(find("Mäuse painted", "Maus. Painting is in progress.")).toBeNull();
  expect(find("Mäuse painting", "Maus. Painted walls were inspected.")).toBeNull();
  expect(find("Mäuse painting", "Maus. Painting is in progress.")).not.toBeNull();
  expect(find("painted", "Painting is in progress.")).not.toBeNull();
});

test("search preserves combining characters and compatibility forms like the reference dictionaries", () => {
  const body = "Mo\u0308rtel fachgerecht auftragen. Ｖｅｒｔｒａｇ geprüft.";
  expect(find("Mo\u0308rtel", body)).not.toBeNull();
  expect(find("Mörtel", body)).toBeNull();
  expect(find("Vertrag", body)).toBeNull();
  expect(find("Ｖｅｒｔｒａｇ", body)).not.toBeNull();
});

test("document lexemes use the same simple lowercase as PostgreSQL", () => {
  const body = "İnventar ΟΣ";
  expect(find("inventar", body).excerpt.highlights).toEqual([
    { start: 0, end: 8 },
  ]);
  expect(find("οσ", body).excerpt.highlights).toEqual([
    { start: 9, end: 11 },
  ]);
  expect(find("ος", body)).toBeNull();
});

test("non-ASCII file names retain the reference parser's dot boundaries", () => {
  expect(find("Mörtel", null, "Mörtel.pdf")).not.toBeNull();
  expect(find("2026.pdf", null, "Mörtel.2026.pdf")).not.toBeNull();
  expect(find("Mörtel", null, "mörtel12.pdf")).toBeNull();
  expect(find("mörtel12.pdf", null, "mörtel12.pdf")).not.toBeNull();
  expect(find("Über", null, "Abnahme.über.pdf")).not.toBeNull();
  expect(find("Über_2026.pdf", null, "Über_2026.pdf")).not.toBeNull();
  expect(find("Über", null, "Mörtel-Über.pdf")).not.toBeNull();
  expect(find("inventar", null, "İnventar.pdf")).not.toBeNull();
  expect(find("οσ", null, "ΟΣ.pdf")).not.toBeNull();
});

test("the literal alternative of a quoted phrase requires every term but not adjacency", () => {
  const adjacent = find('"rote Fenster"', "Rote Fenster werden gestrichen.");
  const literal = find('"rote Fenster"', "Rote alte Fenster werden gestrichen.");

  expect(adjacent.rank).toBeGreaterThan(literal.rank);
  expect(literal.excerpt.highlights.map(({ start, end }) =>
    literal.excerpt.text.slice(start, end),
  )).toEqual(["Rote", "Fenster"]);
  expect(find('"rote Fenster"', "Fenster werden rot gestrichen.")).toBeNull();
  expect(find('"rote Fenster"', "Fenster montieren", "rote")).not.toBeNull();
  expect(
    find('"verputzte Wand"', "Die verputzten Wände werden geprüft."),
  ).not.toBeNull();
});

test("AND, OR and exclusions retain their clause boundaries", () => {
  expect(
    find("Fenster -Asbest", "Fenster ohne Sonderleistung."),
  ).not.toBeNull();
  expect(find("Fenster -Asbest", "Fenster mit Asbestplatten.")).not.toBeNull();
  // The English alternative excludes the unchanged lexeme "mäuse", not "maus".
  expect(
    find("Fenster -Mäuse", "Fenster mit einer Maus im Keller."),
  ).not.toBeNull();
  expect(
    find('"Fenster ausbauen" OR Fassade -Asbest', "Fassade neu verputzen."),
  ).not.toBeNull();
  expect(
    find('"Fenster ausbauen" OR Fassade -Asbest', "Fassade mit Asbest."),
  ).toBeNull();
  expect(
    find(
      '"Fenster ausbauen" OR Fassade -Asbest',
      "Fenster ausbauen, Asbest beachten.",
    ),
  ).not.toBeNull();
  expect(
    find("Fenster OR Türen", "Dort sind Türen vorgesehen."),
  ).not.toBeNull();
  expect(find("Fenster Türen", "Dort sind Türen vorgesehen.")).toBeNull();
});

test("whitespace after a minus keeps the exclusion and two minuses cancel", () => {
  const body = "Geländer sichern";

  expect(find("Geländer - Anschluss", body)).not.toBeNull();
  expect(find("Geländer --Anschluss", body)).toBeNull();
  expect(find("Geländer --Anschluss", "Geländer Anschluss prüfen")).not.toBeNull();
});

test("parentheses separate web operands without grouping them", () => {
  expect(find("Geländer (-Anschluss)", "Geländer sichern")).not.toBeNull();
  expect(find("Geländer(-Anschluss)", "Geländer sichern")).not.toBeNull();
  expect(find("Geländer (-(Anschluss))", "Geländer sichern")).not.toBeNull();
  expect(find("Geländer (-(-Anschluss))", "Geländer sichern")).toBeNull();
  expect(find("Geländer,-Anschluss", "Geländer sichern")).toBeNull();
  expect(
    find('Geländer (-("neue Anschlüsse"))', "An Geländern die Anschlüsse sichern"),
  ).not.toBeNull();
  expect(
    find('Geländer (-("neue Anschlüsse"))', "An Geländern neue Anschlüsse sichern"),
  ).toBeNull();
  expect(find("Geländer (Tor OR Wand)", "Die Wand sichern")).not.toBeNull();
});

test("OR before punctuation remains an operator without surrounding spaces", () => {
  expect(find("Geländer OR(Anschluss)", "Anschlüsse prüfen")).not.toBeNull();
  expect(find('Geländer OR"Anschluss"', "Anschlüsse prüfen")).not.toBeNull();
  expect(find("Geländer OR!Anschluss", "Anschlüsse prüfen")).not.toBeNull();
  expect(find("Geländer OR-Anschluss", "Anschlüsse prüfen")).toBeNull();
  expect(find("Geländer OR_Anschluss", "Anschlüsse prüfen")).toBeNull();
});

test("unquoted exclamation marks and ampersands separate web operands", () => {
  for (const separator of ["!", "&"]) {
    const alternative = `Geländer${separator}OR Anschluss`;
    const exclusion = `Geländer${separator}-Anschluss`;

    expect(find(alternative, "Anschlüsse prüfen")).not.toBeNull();
    expect(find(exclusion, "Geländer sichern")).not.toBeNull();
    expect(find(exclusion, "Anschlüsse prüfen")).toBeNull();
  }
  expect(find('"Geländer!OR Anschluss"', "Anschlüsse prüfen")).toBeNull();
});

test("file paths retain their leading slash after a separator", () => {
  const path = "/planung/halle.dwg";
  const body = `Planung=-${path}.`;

  expect(find(path, body)?.excerpt?.highlights).toEqual([
    { start: body.indexOf(path), end: body.length - 1 },
  ]);
  expect(find(`Planung=-${path}`, `Planung ${path}`)).not.toBeNull();
  expect(find(`Planung=-${path}`, "Planung halle.dwg")).toBeNull();
  expect(find("/halle.dwg", "vorentwurf-/halle.dwg")).not.toBeNull();
  expect(find("/halle.dwg", "/vorentwurf-/halle.dwg")).toBeNull();
});

test("phrases of different lengths can share a final word without sharing their preceding words", () => {
  const query = '"die roten Fenster" OR "Fenster" -"neue Fenster"';
  const { excerpt } = find(query, "Neue Fenster gegen die roten FENSTER tauschen.");
  expect(
    excerpt.highlights.map(({ start, end }) => excerpt.text.slice(start, end)),
  ).toEqual(["roten FENSTER"]);
  expect(find(query, "die roten alten Fenster und neue Fenster")).toBeNull();
  expect(find(query, "Fenster sind im Plan markiert.")).not.toBeNull();
});

test("incomplete quotes and punctuation are tolerated without turning empty input into all documents", () => {
  expect(find('"rote Fenster', "Rote Fenster einbauen.")).not.toBeNull();
  for (const query of ["", " ", "---", '""', "OR", "OR OR", "… !!!"]) {
    expect(find(query, "Rote Fenster einbauen.")).toBeNull();
  }
  expect(find("Fenster OR", "Fenster einbauen.")).not.toBeNull();
});

test("literal terms are also searched when the query contains exclusions", () => {
  expect(find("Stahl -Beton", "Stahl für das Tor.")).not.toBeNull();
  expect(find("Stahl -Beton", "Stahl und Beton.")).not.toBeNull();
  expect(find("Stahl -Beton", "Nur Beton.")).toBeNull();
  expect(find("-Asbest", "Fenster einbauen.")).not.toBeNull();
  expect(find("-Asbest", "Asbest entfernen.")).not.toBeNull();
});

test("whole words and dotted terms match without treating unfinished terms as explicit prefixes", () => {
  expect(find("Stahl", "Stahl für das Tor.")).not.toBeNull();
  expect(find("Stah", "Stahl für das Tor.")).toBeNull();
  expect(
    find("26-4711_Leistungsverzeichnis.pdf", null, "26-4711_Leistungsverzeichnis.pdf"),
  ).not.toBeNull();
  expect(find("Anschl", null, "Anschlussdetails.pdf")).toBeNull();
  expect(find("Anschlussdetails", null, "Anschlussdetails.pdf")).toBeNull();
  expect(find("Anschlussdetails.pdf", null, "Anschlussdetails.pdf")?.excerpt).toBeNull();

  const url = "https://beispiel.test/tor";
  expect(find("Tor", url)).toBeNull();
  expect(find(url, url)).not.toBeNull();
});

test("a URL keeps host and path highlights at their original offsets", () => {
  const text = "Siehe https://beispiel.test/tor";

  for (const query of ["beispiel.test", "/tor"]) {
    const match = find(query, text);
    expect(match?.excerpt?.highlights).toEqual([
      { start: text.indexOf(query), end: text.indexOf(query) + query.length },
    ]);
  }
});

test("email addresses match and highlight as one lexeme without sentence punctuation", () => {
  const address = "Bauleitung.West@beispiel.test";
  const text = `Kontakt ${address}. Danach folgt der Termin.`;
  const match = find(address.toLowerCase(), text);

  expect(match?.excerpt?.highlights).toEqual([
    { start: text.indexOf(address), end: text.indexOf(address) + address.length },
  ]);
  expect(find("Bauleitung.West", text)).toBeNull();
  expect(find("beispiel.test", text)).toBeNull();
  expect(find("e@example.test", "maße@example.test")).toBeNull();
});

test("only satisfied alternatives contribute to rank; the best one determines the excerpt", () => {
  const body =
    "Asbest und Abbruch im Altbau. " +
    "Allgemeine Hinweise zur Baustelle. ".repeat(22) +
    "Die Fenster werden eingesetzt.";
  const result = find("Fenster OR Asbest Abbruch Genehmigung", body);
  expect(result.rank).toBe(find("Fenster", body).rank);
  expect(result.excerpt.text).toContain("Die Fenster werden eingesetzt.");
  expect(result.excerpt.text).not.toContain("Abbruch");

  const nearby = find(
    "Fenster OR Asbest Rückbau",
    "Fenster mit Asbest im Plan.",
  );
  const highlighted = nearby.excerpt.highlights.map(({ start, end }) =>
    nearby.excerpt.text.slice(start, end),
  );
  expect(highlighted).toEqual(["Fenster"]);

  const query = "Stahl OR Beton";
  expect(find(query, "Stahl und Beton").rank).toBeGreaterThan(
    find(query, null, "Beton Stahl.pdf").rank,
  );
});

test("matches without a positive body hit have no excerpt", () => {
  expect(
    find("AB-12", "Montagehinweise.", "AB-12 Leistungsverzeichnis.pdf").excerpt,
  ).toBeNull();
  expect(find("-Asbest", "Neue Fenster im Bauabschnitt.").excerpt).toBeNull();
});

test("relevance favors nearby terms and names rather than arbitrary modification order or repetition", () => {
  const dense = find("Fenster Wand", "Fenster neben der Wand montieren.");
  const spread = find(
    "Fenster Wand",
    "Fenster " + "Baustelle ".repeat(100) + "Wand",
  );
  expect(dense.rank).toBeGreaterThan(spread.rank);
  const named = find("Fenster", "Montage in Raum 101.", "Fenster Plan.pdf");
  const body = find("Fenster", "Fenster in Raum 101.", "Anlage.pdf");
  expect(named.rank).toBeGreaterThan(body.rank);
  const repeated = find("Fenster", "Fenster ".repeat(1000));
  expect(repeated.rank).toBeLessThan(
    find("Fenster", "Fenster ".repeat(8)).rank,
  );
});

test("a single matching term still counts repeated hits at the same document length", () => {
  expect(find("Stahl", "Stahl Stahl").rank).toBeGreaterThan(
    find("Stahl", "Stahl Aufbau").rank,
  );
});

test("excerpts surround a late hit and use bounded literal text with character ranges", () => {
  const body =
    "Allgemeine Vorbemerkung. ".repeat(150) +
    "Die Wände am Fenster werden gestrichen. " +
    "Abschluss. ".repeat(150);
  const { excerpt } = find("Wand Fenster", body);
  expect(excerpt.text).toContain("Wände am Fenster");
  expect(excerpt.text.startsWith("… ")).toBe(true);
  expect(excerpt.text.endsWith(" …")).toBe(true);
  expect(excerpt.text.length).toBeLessThanOrEqual(444);
  expect(
    excerpt.highlights.map(({ start, end }) => excerpt.text.slice(start, end)),
  ).toEqual(["Wände", "Fenster"]);
  for (let index = 1; index < excerpt.highlights.length; index++) {
    expect(excerpt.highlights[index].start).toBeGreaterThanOrEqual(
      excerpt.highlights[index - 1].end,
    );
  }
});

test("overlapping phrase and term hits merge, and untrusted HTML and former markers remain literal", () => {
  const { excerpt } = find(
    '"rote Fenster" Fenster',
    '<<Abschnitt>> <img src=x onerror="alert(1)"> rote Fenster',
  );
  const html = renderToStaticMarkup(
    createElement(DocumentExcerpt, { value: excerpt }),
  );
  expect(html).toContain("&lt;&lt;Abschnitt&gt;&gt;");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).toContain("<mark>rote Fenster</mark>");
});

test("unicode snippets retain whole surrogate pairs and original combining characters", () => {
  const { excerpt } = find(
    "Mo\u0308rtel",
    "😀".repeat(120) + " Mo\u0308rtel auftragen " + "😀".repeat(250),
  );
  expect(excerpt.text.isWellFormed()).toBe(true);
  expect(
    excerpt.highlights.map(({ start, end }) => excerpt.text.slice(start, end)),
  ).toEqual(["Mo\u0308rtel"]);
});

test("oversized input is rejected without echoing private query content", () => {
  expect(() => createDocumentMatcher("geheim".repeat(200))).toThrow(
    "Document query is too long",
  );
});

test("cached word positions and uncached overflow produce identical matches", () => {
  const tokenizer = createDocumentTokenizer(16);
  const cached = "Die rote Wand vor dem Fenster.";
  const overflow = "Neue Türen. ".repeat(100) + cached;
  createDocumentMatcher("Fenster", tokenizer).match("Anlage.txt", cached);

  for (const body of [cached, overflow]) {
    for (const query of ['"rote Wand"', "Fenster -Türen", "Wand OR Türen"]) {
      const reused = createDocumentMatcher(query, tokenizer).match("Anlage.txt", body);
      expect(reused).toEqual(find(query, body, "Anlage.txt"));
    }
  }
});

test("a warmed vocabulary skips impossible bodies without changing matches or excerpts", () => {
  const tokenizer = createDocumentTokenizer(64);
  const body = "Die verputzten Wände und Fensteranschlüsse. Installed window frames.";
  const name = "Abnahme 4711.pdf";
  expect(createDocumentMatcher("Wand", tokenizer).match(name, body)).not.toBeNull();

  let bodyScans = 0;
  const observed = {
    ...tokenizer,
    scan(text, ...args) {
      if (text === body) bodyScans++;
      return tokenizer.scan(text, ...args);
    },
  };
  for (const query of ["Fenst", "Wand Rechnung", '"neue Decke" OR Dach', "4711 Türen"]) {
    expect(createDocumentMatcher(query, observed).match(name, body)).toBeNull();
  }
  expect(bodyScans).toBe(0);

  for (const query of [
    "Fenst Wand",
    "4711",
    "install",
    '"verputzte Wand" OR Fenster -Asbest',
    '"Wände verputzten"',
    "-Wand",
    "-Asbest",
  ]) {
    expect(createDocumentMatcher(query, observed).match(name, body))
      .toEqual(find(query, body, name));
  }
  expect(bodyScans).toBeGreaterThan(0);
});

test("the native search provider uses the local matcher and honors cancellation", async () => {
  const { search } = createDocumentSearch();
  const documents = Array.from({ length: 35 }, (_, index) => ({
    id: String(index),
    name: `Anlage ${index}.pdf`,
    text: "Die Wände wurden gestrichen.",
  }));
  const found = await search(
    documents,
    "Wand",
    new AbortController().signal,
  );
  expect(found.map(({ id }) => id)).toEqual(documents.map(({ id }) => id));
  expect(found[0].excerpt.highlights).not.toHaveLength(0);
  const controller = new AbortController();
  controller.abort();
  await expect(search(documents, "Wand", controller.signal)).rejects.toThrow();
});

test("a new query reuses acknowledged document batches and a cleared snapshot resends them", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const messages = [];
  let receive;
  function nextMessage() {
    return messages.shift() ?? new Promise((resolve) => {
      receive = resolve;
    });
  }
  class SearchWorker {
    terminated = false;

    postMessage(input) {
      const sent = { worker: this, input };
      if (receive) {
        const resolve = receive;
        receive = undefined;
        resolve(sent);
      } else messages.push(sent);
    }

    reply() {
      this.onmessage({ data: { matches: [] } });
    }

    terminate() {
      this.terminated = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: SearchWorker });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
  const provider = createDocumentSearch();
  const documents = Array.from({ length: 17 }, (_, index) => ({
    id: String(index),
    name: `Plan ${index}`,
    text: "Neue Fenster und Türanschlüsse",
  }));
  const signal = new AbortController().signal;
  try {
    const aborted = provider.search(documents, "Fenster", signal).catch((error) => error);
    const first = await nextMessage();
    expect(first.input.batches[0].source.documents).toHaveLength(16);

    const refined = provider.search(documents, "Türanschlüsse", signal);
    first.worker.reply();
    expect((await aborted).name).toBe("AbortError");
    const reused = await nextMessage();
    expect(reused.worker).toBe(first.worker);
    expect(reused.input).toEqual({ query: "Türanschlüsse", batches: [{ batch: 0 }] });
    reused.worker.reply();
    const rest = await nextMessage();
    expect(rest.input.batches[0].source.documents).toHaveLength(1);
    rest.worker.reply();
    expect(await refined).toEqual([]);

    const cleared = provider.search(documents, "Plan", signal).catch((error) => error);
    const previous = await nextMessage();
    expect(previous.input.batches[0].source).toBeUndefined();
    provider.clear();
    expect(previous.worker.terminated).toBe(true);
    expect((await cleared).name).toBe("AbortError");

    const refreshed = provider.search(documents, "Fenster", signal);
    const fresh = await nextMessage();
    expect(fresh.worker).not.toBe(previous.worker);
    expect(fresh.input.batches[0].source.documents).toHaveLength(16);
    fresh.worker.reply();
    const last = await nextMessage();
    last.worker.reply();
    expect(await refreshed).toEqual([]);

    provider.clear();
    const firstProject = documents.slice(0, 16);
    const secondProject = documents.slice(16);
    const grouped = provider.searchGroups(
      [firstProject, secondProject],
      "Fenster",
      signal,
    );
    const firstGroup = await nextMessage();
    firstGroup.worker.reply();
    const secondGroup = await nextMessage();
    secondGroup.worker.reply();
    expect(await grouped).toEqual([]);

    const revisedProject = [{ ...firstProject[0], text: "Fenster neu eingesetzt" }];
    const changed = provider.searchGroups(
      [revisedProject, secondProject],
      "Fenster",
      signal,
    );
    const eviction = await nextMessage();
    expect(eviction.input).toEqual({ discard: [firstGroup.input.batches[0].batch] });
    expect(eviction.worker).toBe(firstGroup.worker);
    eviction.worker.reply();
    const revised = await nextMessage();
    expect(revised.input.batches).toHaveLength(2);
    expect(revised.input.batches[0].source.documents).toEqual(revisedProject);
    expect(revised.input.batches[1]).toEqual({
      batch: secondGroup.input.batches[0].batch,
    });
    revised.worker.reply();
    expect(await changed).toEqual([]);

    provider.clear();
    const oversized = [{ id: "big", name: "Bericht", text: "x".repeat(4 * 1024 * 1024) }];
    for (const query of ["Bericht", "Fenster"]) {
      const result = provider.search(oversized, query, signal);
      const sent = await nextMessage();
      expect(sent.input.batches[0].source).toEqual({ documents: oversized, retain: false });
      sent.worker.reply();
      expect(await result).toEqual([]);
    }
  } finally {
    provider.clear();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else delete globalThis.Worker;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
  }
});
