import { searchEmail, searchFilePath, searchHost, searchUrlPath } from "./addressLexemes";
import { simpleLowercase } from "./simpleLowercase";

// Common lexeme forms of the former PostgreSQL "simple" catalogue search.
// The default PostgreSQL parser also has locale-specific and less common
// cases. Keep the order here aligned with the reference match fixtures.
const compoundPart = "[\\p{N}]*\\p{L}[\\p{L}\\p{M}\\p{N}]*";
const word = "[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*";
const wordPattern = new RegExp(word, "gu");
const specialPunctuation = /[/<@+-]|[a-z0-9]\.[a-z0-9]|&[a-z0-9#]+;/;

const lexemePattern = new RegExp(
  [
    "<!--[\\s\\S]*?-->|</?[a-z_:][a-z0-9_.:-]*(?:\\s+[^<>]*)?\\s*/?>|&[a-z0-9#]+;",
    "(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*://",
    `(?<email>${searchEmail})`,
    `(?<host>${searchHost})(?<path>${searchUrlPath})?`,
    "(?<number>[+-]?[0-9]+(?:\\.[0-9]+)*(?:e[+-]?[0-9]+)|[+-]?[0-9]+(?:\\.[0-9]+)+|[+-][0-9]+)",
    `(?<file>${searchFilePath}|[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)+)`,
    "(?<compound>" + compoundPart + "(?:-" + compoundPart + ")+)",
    "(?<word>" + word + ")",
  ].join("|"),
  "gu",
);

function lexemes(text: string): string[] {
  // The lexer distinguishes ASCII address syntax from ordinary Unicode words.
  // Apply the dictionary's Unicode lowercase mapping only after tokenization.
  const input = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  if (!specialPunctuation.test(input))
    return (input.match(wordPattern) ?? []).map(simpleLowercase);

  const words: string[] = [];
  let compoundEnd = -1;
  for (const match of input.matchAll(lexemePattern)) {
    const { email, host, path, number, file, compound, word } = match.groups!;
    if (host && path && path !== "/") {
      words.push(host + path, host, path);
    } else if (compound) {
      words.push(compound, ...compound.split("-"));
      compoundEnd = match.index + compound.length;
    } else if (number) {
      // After a recognized compound PostgreSQL consumes the separating dash
      // when a remaining part consists of digits.
      if (match.index === compoundEnd && number.startsWith("-"))
        words.push(number.slice(1));
      else words.push(number);
    } else {
      const single = email ?? host ?? file ?? word;
      if (single !== undefined) words.push(single);
    }
  }
  return words.map(simpleLowercase);
}

function containsPrefixSequence(
  words: readonly string[],
  prefixes: readonly string[],
): boolean {
  return words.some((word, index) => {
    if (index + prefixes.length > words.length || !word.startsWith(prefixes[0]!))
      return false;
    for (let offset = 1; offset < prefixes.length; offset++) {
      if (!words[index + offset]!.startsWith(prefixes[offset]!)) return false;
    }
    return true;
  });
}

/** The former create_query joined space-separated fragments with AND. The
 * lexemes produced within one fragment must be adjacent and in order. */
type SearchText = { text: string; lowercase: string; words?: readonly string[] };

function searchText(values: readonly unknown[]): SearchText {
  const text = values.join(" ");

  return { text, lowercase: simpleLowercase(text) };
}

function compilePrefixQuery(search: string | null | undefined) {
  const query = search?.trim();
  if (!query) return null;

  const sequences = query.split(" ").map(lexemes).filter((words) => words.length);
  if (!sequences.length) return () => false;

  const candidates = sequences.map((prefixes) =>
    prefixes.reduce((longest, prefix) =>
      prefix.length > longest.length ? prefix : longest,
    ),
  );
  return (text: SearchText) => {
    // Every emitted lexeme is a substring of the input. Save tokenization for
    // rows that contain at least one prefix from every search fragment.
    if (!candidates.every((prefix) => text.lowercase.includes(prefix))) return false;
    const words = (text.words ??= lexemes(text.text));
    return sequences.every((prefixes) => containsPrefixSequence(words, prefixes));
  };
}

export function createPrefixMatcher(search: string | null | undefined) {
  const matches = compilePrefixQuery(search);
  return (values: readonly unknown[]) => !matches || matches(searchText(values));
}

/** Prepare search text and lexemes on demand for one verified snapshot.
 * Return independent values so a consumer cannot edit the cached directory. */
export function buildPrefixSearch<Row>(
  orderedRows: readonly Row[],
  fields: (row: Row) => readonly unknown[],
) {
  const entries = orderedRows.map<{ row: Row; text?: SearchText }>((row) => ({
    row,
  }));
  return (
    search: string | null | undefined,
    eligible: (row: Row) => boolean = () => true,
    limit = Infinity,
  ): Row[] => {
    const matches = compilePrefixQuery(search);
    const rows: Row[] = [];
    for (const entry of entries) {
      if (rows.length === limit) break;
      if (!eligible(entry.row)) continue;
      if (matches) {
        const text = (entry.text ??= searchText(fields(entry.row)));
        if (!matches(text)) continue;
      }
      rows.push(entry.row);
    }
    return structuredClone(rows);
  };
}
