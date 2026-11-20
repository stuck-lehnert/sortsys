import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocumentMatcher, createDocumentTokenizer } from "./documentQuery";
import { createDocumentSearch } from "./documentSearch";
import { DocumentExcerpt } from "../../components/DocumentExcerpt";

const find = (query, body, name = "Ausführung.pdf") =>
  createDocumentMatcher(query).match(name, body);

test("German and English inflections and decomposed umlauts are searched locally", () => {
  expect(find("Wand", "Die Wände werden gestrichen.")).not.toBeNull();
  expect(find("Maus", "Mäuse wurden im Keller festgestellt.")).not.toBeNull();
  expect(
    find("install", "Installed windows passed inspection."),
  ).not.toBeNull();
  expect(find("Mörtel", "Mo\u0308rtel fachgerecht auftragen.")).not.toBeNull();
  expect(
    find("Fenst Abdicht", "Fensterlaibungen vollständig abdichten."),
  ).not.toBeNull();
  expect(find("Fenster Rechnung", "Fenster werden eingebaut.")).toBeNull();
});

test("quoted phrases require adjacent ordered words and do not cross file-name boundaries", () => {
  expect(
    find('"rote Fenster"', "Rote Fenster werden gestrichen."),
  ).not.toBeNull();
  expect(find('"rote Fenster"', "Fenster werden rot gestrichen.")).toBeNull();
  expect(
    find('"rote Fenster"', "Rote alte Fenster werden gestrichen."),
  ).toBeNull();
  expect(find('"rote Fenster"', "Fenster montieren", "rote")).toBeNull();
  expect(
    find('"verputzte Wand"', "Die verputzten Wände werden geprüft."),
  ).not.toBeNull();
});

test("AND, OR and exclusions retain their clause boundaries", () => {
  expect(
    find("Fenster -Asbest", "Fenster ohne Sonderleistung."),
  ).not.toBeNull();
  expect(find("Fenster -Asbest", "Fenster mit Asbestplatten.")).toBeNull();
  expect(
    find("Fenster -Mäuse", "Fenster mit einer Maus im Keller."),
  ).toBeNull();
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

test("phrases of different lengths can share a final word without sharing their preceding words", () => {
  const query = '"die roten Fenster" OR "Fenster" -"neue Fenster"';
  const { excerpt } = find(query, "Neue Fenster gegen die roten FENSTER tauschen.");
  expect(
    excerpt.highlights.map(({ start, end }) => excerpt.text.slice(start, end)),
  ).toEqual(["die roten FENSTER"]);
  expect(find(query, "die roten alten Fenster und neue Fenster")).toBeNull();
  expect(find(query, "Fenster sind im Plan markiert.")).not.toBeNull();
});

test("incomplete quotes and punctuation are tolerated without turning empty input into all documents", () => {
  expect(find('"rote Fenster', "Rote Fenster einbauen.")).not.toBeNull();
  for (const query of ["", " ", "---", '""', "OR", "OR OR", "… !!!"]) {
    expect(find(query, "Rote Fenster einbauen.")).toBeNull();
  }
  expect(find("Fenster OR", "Fenster einbauen.")).not.toBeNull();
  expect(find("-Asbest", "Fenster einbauen.")).not.toBeNull();
  expect(find("-Asbest", "Asbest entfernen.")).toBeNull();
});

test("references and file-name prefixes remain searchable without a body", () => {
  expect(
    find("26 4711 Leist", null, "26-4711_Leistungsverzeichnis.pdf"),
  ).not.toBeNull();
  expect(find("Anschl", null, "Anschlussdetails.pdf")?.excerpt).toBeNull();
});

test("an unsatisfied alternative contributes neither ranking nor excerpt highlights", () => {
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
  const named = find("Fenster", "Montage in Raum 101.", "Fenster.pdf");
  const body = find("Fenster", "Fenster in Raum 101.", "Anlage.pdf");
  expect(named.rank).toBeGreaterThan(body.rank);
  const repeated = find("Fenster", "Fenster ".repeat(1000));
  expect(repeated.rank).toBeLessThan(
    find("Fenster", "Fenster ".repeat(8)).rank,
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
    "Mörtel",
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
    expect(first.input.source.documents).toHaveLength(16);

    const refined = provider.search(documents, "Türanschlüsse", signal);
    first.worker.reply();
    expect((await aborted).name).toBe("AbortError");
    const reused = await nextMessage();
    expect(reused.worker).toBe(first.worker);
    expect(reused.input).toEqual({ query: "Türanschlüsse", batch: 0 });
    reused.worker.reply();
    const rest = await nextMessage();
    expect(rest.input.source.documents).toHaveLength(1);
    rest.worker.reply();
    expect(await refined).toEqual([]);

    const cleared = provider.search(documents, "Plan", signal).catch((error) => error);
    const previous = await nextMessage();
    expect(previous.input.source).toBeUndefined();
    provider.clear();
    expect(previous.worker.terminated).toBe(true);
    expect((await cleared).name).toBe("AbortError");

    const refreshed = provider.search(documents, "Fenster", signal);
    const fresh = await nextMessage();
    expect(fresh.worker).not.toBe(previous.worker);
    expect(fresh.input.source.documents).toHaveLength(16);
    fresh.worker.reply();
    const last = await nextMessage();
    last.worker.reply();
    expect(await refreshed).toEqual([]);

    const oversized = [{ id: "big", name: "Bericht", text: "x".repeat(4 * 1024 * 1024) }];
    for (const query of ["Bericht", "Fenster"]) {
      const result = provider.search(oversized, query, signal);
      const sent = await nextMessage();
      expect(sent.input.source).toEqual({ documents: oversized, retain: false });
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
