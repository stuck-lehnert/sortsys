import { stemmer as germanStemmer } from "@orama/stemmers/german";
import { stemmer as englishStemmer } from "@orama/stemmers/english";
import stopWords from "../../../vendor/postgresql-stopwords/words.json";
import { searchEmail, searchFilePath, searchHost, searchUrlPath } from "./addressLexemes";
import { simpleLowercase } from "./simpleLowercase";

export type TextRange = { start: number; end: number };
export type DocumentExcerpt = { text: string; highlights: TextRange[] };
export type DocumentMatch = { rank: number; excerpt: DocumentExcerpt | null };
export type SearchDocument = Readonly<{
  id: string;
  name: string;
  text: string | null;
}>;
export type SearchMatch = DocumentMatch & { id: string };

type RankedDocument = Pick<SearchMatch, "rank" | "id"> & { modifiedAtMicros: bigint };

export function compareRankedDocuments(a: RankedDocument, b: RankedDocument) {
  const relevance = b.rank - a.rank;
  if (relevance) return relevance;
  if (a.modifiedAtMicros !== b.modifiedAtMicros)
    return a.modifiedAtMicros > b.modifiedAtMicros ? -1 : 1;

  // Public file IDs are canonical base-32 integers. Compare digits without
  // parsing 64-bit IDs or applying a locale-dependent string order.
  const length = b.id.length - a.id.length;
  if (length || a.id === b.id) return length;
  return a.id < b.id ? 1 : -1;
}

export const MAX_CACHED_DOCUMENT_WORDS = 200_000;
const WORD_CACHE_LIMIT = 1024;
type Word = { plain: string; german: string | null; english: string | null };
type Term = {
  words: Word[];
  phrase: boolean;
  excluded: boolean;
};
type Atom = Omit<Term, "words"> & {
  lastWord: string;
  precedingWords: (string | null)[];
  clause: number;
};
type Hit = TextRange & { atom: number; position: number };
type ClauseHits = {
  recent: Hit[];
  counts: Map<number, number>;
  best: { quality: number; range: TextRange } | null;
};
const fileDictionaries = ["plain"] as const;
const bodyDictionaries = ["german", "english"] as const;
const germanStopWords = new Set(stopWords.german);
const englishStopWords = new Set(stopWords.english);

const plainWords = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
const compoundPart = "\\p{L}[\\p{L}\\p{M}\\p{N}]*";
const compoundWord = `(?<compound>${compoundPart}(?:-${compoundPart})+)`;
const textWords = new RegExp(`${compoundWord}|${plainWords.source}`, "gu");
const dottedPart = "[A-Za-z0-9][A-Za-z0-9_-]*";
// The reference parser separates ordinary non-ASCII words at a dot, but
// permits a leading letter-and-number token such as mörtel12 in a file name.
const numberedWord = "(?=[\\p{L}\\p{M}]+\\d)[\\p{L}][\\p{L}\\p{M}\\d]*";
const dottedWord = `(?:${dottedPart}|${numberedWord})(?:\\.${dottedPart})+`;
const dottedWords = new RegExp(`${dottedWord}|${textWords.source}`, "gu");
const addressWords = new RegExp(
  [
    searchEmail,
    `(?:https?://)?(?<host>${searchHost})(?<path>${searchUrlPath})?`,
    searchFilePath,
    dottedWord,
    textWords.source,
  ].join("|"),
  "giu",
);

function wordPattern(text: string) {
  // File names with extensions don't need the heavier URL and path parser.
  if (text.includes("/") || text.includes("@") || /\.[a-z]{2,}:\d/i.test(text))
    return addressWords;

  return /\.[\p{L}\p{N}]/u.test(text) ? dottedWords : textWords;
}

type Token = TextRange & { word: Word };
type CachedDocument = { tokens: Token[]; vocabulary?: Set<string> };
type ReadToken = (
  word: Word,
  start: number,
  end: number,
  position: number,
) => void;

function vocabularyFor(tokens: Token[]): Set<string> {
  const vocabulary = new Set<string>();

  for (const { word } of tokens) {
    if (word.german !== null) vocabulary.add(word.german);
    if (word.english !== null) vocabulary.add(word.english);
  }

  return vocabulary;
}

export function createDocumentTokenizer(maxCachedWords = 0) {
  const words = new Map<string, Word>();
  const documents = new Map<string, CachedDocument>();
  let remainingWords = maxCachedWords;
  let remainingCharacters = maxCachedWords * 10;

  function word(input: string): Word {
    const known = words.get(input);
    if (known) return known;

    // PostgreSQL's text dictionaries receive the original code points. Do not
    // fold combining characters or compatibility forms before stemming.
    const scheme = input.indexOf("://");
    const plain = simpleLowercase(scheme < 0 ? input : input.slice(scheme + 3));
    // Identifiers and giant words need no linguistic processing.
    const result =
      plain.length > 256 || plain.includes(".") || plain.includes("/")
        ? { plain, german: plain, english: plain }
        : {
            plain,
            german: germanStopWords.has(plain) ? null : germanStemmer(plain),
            english: englishStopWords.has(plain) ? null : englishStemmer(plain),
          };
    if (input.length <= 256 && plain.length <= 256) {
      if (words.size >= WORD_CACHE_LIMIT) words.delete(words.keys().next().value!);
      words.set(input, result);
    }
    return result;
  }

  function scan(text: string, read: ReadToken, remember: boolean): number {
    const cached = remember ? documents.get(text)?.tokens : undefined;
    if (cached) {
      for (let position = 0; position < cached.length; position++) {
        const { word, start, end } = cached[position]!;
        read(word, start, end, position);
      }
      return cached.length;
    }

    // Keep the first sequences that fit. Large files and full caches still
    // stream through the same matcher without displacing a warm working set.
    let entry: Token[] | null = null;
    if (remember && remainingWords > 0 && text.length <= remainingCharacters) {
      entry = [];
    }
    let position = 0;
    function visit(value: string, start: number) {
      const token = word(value);
      const end = start + value.length;
      if (entry && position >= remainingWords) entry = null;
      entry?.push({ word: token, start, end });
      read(token, start, end, position);
      position++;
    }

    // Each scan owns the cursor, including scans triggered by a reader.
    const pattern = new RegExp(wordPattern(text));
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const value = match[0];
      const path = match.groups?.path;
      if (!path || path === "/") {
        visit(path ? value.slice(0, -1) : value, match.index);

        if (match.groups?.compound) {
          for (const part of value.matchAll(plainWords)) {
            visit(part[0], match.index + part.index);
          }
        }
        continue;
      }

      // The former vector stored an address, its host and its path at
      // consecutive positions, without indexing the protocol separately.
      const host = match.groups!.host!;
      const pathStart = match.index + value.length - path.length;
      visit(value, match.index);
      visit(host, pathStart - host.length);
      visit(path, pathStart);
    }

    if (entry && position > 0) {
      documents.set(text, { tokens: entry });
      remainingWords -= position;
      remainingCharacters -= text.length;
    }
    return position;
  }

  // Only a complete cached text can prove that a term is absent. Phrase
  // adjacency and ranking still require the exact positional matcher.
  function mayContain(text: string, lexeme: string): boolean {
    const cached = documents.get(text);
    if (!cached) return true;

    const vocabulary = (cached.vocabulary ??= vocabularyFor(cached.tokens));
    return vocabulary.has(lexeme);
  }

  function forget(texts: Iterable<string>) {
    for (const text of texts) {
      const cached = documents.get(text);
      if (!cached) continue;
      documents.delete(text);
      remainingWords += cached.tokens.length;
      remainingCharacters += text.length;
    }
    words.clear();
  }

  return { scan, mayContain, forget };
}

/** Search semantics belong to the local query provider. The UI must not filter
 * its results again. No index, query or excerpt is sent to the API. */
export function createDocumentMatcher(
  query: string,
  tokenizer = createDocumentTokenizer(),
) {
  if (query.length > 1000) throw new RangeError("Document query is too long");

  const branches: Term[][] = [[]];
  let minusCount = 0;
  // Outside quotes these characters separate operands without adding operators.
  for (const [input] of query.matchAll(/"[^"]*(?:"|$)|[^\s"()!&]+/gu)) {
    let operand = input;
    if (!minusCount && /^or(?![\p{L}\p{M}\p{N}_-])/iu.test(operand)) {
      if (branches.at(-1)!.length) branches.push([]);
      operand = operand.slice(2);
    }

    const leadingMinus = /^-+/.exec(operand)?.[0].length ?? 0;
    minusCount += leadingMinus;

    const text = operand.slice(leadingMinus);
    const phrase = text.startsWith('"');
    const words: Word[] = [];
    tokenizer.scan(text, (word) => words.push(word), false);

    if (!words.length) continue;

    // A single unquoted operand can also produce several positions, e.g.
    // the compound and its components or an address, its host and path.
    branches.at(-1)!.push({
      words,
      phrase: phrase || words.length > 1,
      excluded: minusCount % 2 === 1,
    });
    minusCount = 0;
  }
  if (!branches.at(-1)!.length) branches.pop();

  const atoms: Atom[] = [];
  const clauses: { branch: number; atomIds: number[] }[] = [];
  function addClause(branch: number, terms: Term[], dictionary: keyof Word) {
    const atomIds: number[] = [];
    for (const { words, phrase, excluded } of terms) {
      const positions = words.map((word) => word[dictionary]);
      const first = positions.findIndex((lexeme) => lexeme !== null);
      if (first === -1) continue;

      // Stop words at the edges do not anchor a phrase. Those between two
      // searchable lexemes still occupy a position in the phrase.
      let last = positions.length - 1;
      while (positions[last] === null) last--;

      const precedingWords = positions.slice(first, last);
      const lastWord = positions[last]!;
      const id = atoms.length;

      atoms.push({
        precedingWords,
        lastWord,
        phrase,
        excluded,
        clause: clauses.length,
      });
      atomIds.push(id);
    }

    if (atomIds.length) clauses.push({ branch, atomIds });
  }

  // A branch must match one complete query dictionary. The indexed lexemes
  // available to each query are the union of both body dictionaries.
  for (const [branch, terms] of branches.entries()) {
    addClause(branch, terms, "german");
    const differs = terms.some(({ words }) =>
      words.some((word) => word.german !== word.english),
    );
    if (differs) {
      addClause(branch, terms, "english");
    }
  }

  // Master also accepts the conjunction produced by plainto_tsquery('simple').
  // This alternative uses literal terms, with no phrase or exclusion syntax.
  // OR itself is a term. The body participates through its stem dictionaries,
  // so compare these terms to indexed lexemes, not to the original text.
  const plainTerms = new Map<string, Word>();
  tokenizer.scan(query, (term) => plainTerms.set(term.plain, term), false);
  const literalBranch = branches.length;
  if (plainTerms.size) {
    const terms = Array.from(plainTerms.values(), (word) => ({
      words: [word],
      phrase: false,
      excluded: false,
    }));
    addClause(literalBranch, terms, "plain");
  }

  const precedingWordLimit = Math.max(
    0,
    ...atoms.map((atom) => atom.precedingWords.length),
  );
  const atomsByLastWord = new Map<string, number[]>();
  for (const [index, { lastWord }] of atoms.entries()) {
    const indexes = atomsByLastWord.get(lastWord);
    if (indexes) indexes.push(index);
    else atomsByLastWord.set(lastWord, [index]);
  }

  const noCandidates: readonly number[] = [];
  const combinedCandidates = new Map<Word, readonly number[]>();

  function candidates(current: Word, fileName: boolean): readonly number[] {
    if (fileName) return atomsByLastWord.get(current.plain) ?? noCandidates;

    const german =
      current.german === null ? undefined : atomsByLastWord.get(current.german);
    if (current.english === current.german) return german ?? noCandidates;

    const english =
      current.english === null ? undefined : atomsByLastWord.get(current.english);
    if (!german || !english) return german ?? english ?? noCandidates;

    // Only a token that hits two different lexemes needs a merged list.
    // Keep the original atom order for equal-position excerpt windows.
    const cached = combinedCandidates.get(current);
    if (cached) return cached;

    const combined = [...german, ...english].sort((a, b) => a - b);
    if (combinedCandidates.size < WORD_CACHE_LIMIT) {
      combinedCandidates.set(current, combined);
    }
    return combined;
  }

  function scan(
    text: string,
    hit: (value: Hit) => void,
    remember = false,
    fileName = false,
  ): number {
    const preceding: { word: Word; start: number }[] = [];
    const dictionaries = fileName ? fileDictionaries : bodyDictionaries;

    function visitToken(
      current: Word,
      tokenStart: number,
      end: number,
      position: number,
    ) {
      for (const index of candidates(current, fileName)) {
        const atom = atoms[index]!;
        let start = tokenStart;
        if (atom.precedingWords.length) {
          const first = preceding.length - atom.precedingWords.length;
          if (first < 0) continue;

          const adjacent = dictionaries.some(
            (dictionary) =>
              current[dictionary] === atom.lastWord &&
              atom.precedingWords.every(
                (lexeme, offset) =>
                  lexeme === null ||
                  preceding[first + offset]!.word[dictionary] === lexeme,
              ),
          );
          if (!adjacent) continue;

          start = preceding[first]!.start;
        }
        hit({ atom: index, position, start, end });
      }
      if (precedingWordLimit) {
        preceding.push({ word: current, start: tokenStart });
        if (preceding.length > precedingWordLimit) preceding.shift();
      }
    }
    return tokenizer.scan(text, visitToken, remember);
  }

  function excerpt(
    text: string,
    anchor: TextRange,
    clause: number,
  ): DocumentExcerpt {
    let start = Math.max(0, anchor.start - 100);
    let end = Math.min(text.length, start + 400);
    // Prefer whole words and never split a UTF-16 surrogate pair.
    if (start) {
      const nextSpace = text.slice(start, start + 40).search(/\s/u);
      if (nextSpace >= 0 && start + nextSpace < anchor.start)
        start += nextSpace + 1;
      if (/^[\uDC00-\uDFFF]$/.test(text[start]!)) start++;
    }
    if (end < text.length) {
      const nextSpace = text.slice(end, end + 40).search(/\s/u);
      if (nextSpace >= 0) end += nextSpace;
      if (/^[\uDC00-\uDFFF]$/.test(text[end]!)) end--;
    }
    const content = text.slice(start, end);
    const ranges: TextRange[] = [];
    scan(content, (hit) => {
      const atom = atoms[hit.atom]!;
      if (atom.clause === clause && !atom.excluded)
        ranges.push({ start: hit.start, end: hit.end });
    });
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const highlights: TextRange[] = [];
    for (const range of ranges) {
      const previous = highlights.at(-1);
      if (previous && range.start <= previous.end)
        previous.end = Math.max(previous.end, range.end);
      else highlights.push({ ...range });
    }
    // Keep source text literal: it can contain HTML or the former << markers.
    const prefix = start ? "… " : "";
    return {
      text: prefix + content + (end < text.length ? " …" : ""),
      highlights: highlights.map((range) => ({
        start: range.start + prefix.length,
        end: range.end + prefix.length,
      })),
    };
  }

  return {
    hasTerms: clauses.length > 0,
    match(name: string, text: string | null, cacheText = true): DocumentMatch | null {
      if (!clauses.length) return null;
      const names = atoms.map(() => 0);
      const body = atoms.map(() => 0);
      const windows = clauses.map<ClauseHits>(() => ({
        recent: [],
        counts: new Map(),
        best: null,
      }));
      scan(name, (hit) => names[hit.atom]!++, false, true);
      const hasCandidate = clauses.some(({ atomIds }) =>
        atomIds.every((index) => {
          const atom = atoms[index]!;
          if (atom.excluded || names[index]! > 0) return true;
          return !!text && tokenizer.mayContain(text, atom.lastWord);
        }),
      );
      if (!hasCandidate) return null;

      function recordBodyHit(hit: Hit) {
        body[hit.atom]!++;
        const atom = atoms[hit.atom]!;
        if (atom.excluded) return;
        const clauseHits = windows[atom.clause]!;

        // One atom achieves its best possible coverage at the first hit.
        // Keep counting its frequency without maintaining a sliding window.
        if (clauseHits.best && clauses[atom.clause]!.atomIds.length === 1) return;

        clauseHits.recent.push(hit);
        const previousCount = clauseHits.counts.get(hit.atom) ?? 0;
        clauseHits.counts.set(hit.atom, previousCount + 1);
        while (
          clauseHits.recent.length > 256 ||
          hit.position - clauseHits.recent[0]!.position > 60
        ) {
          const expired = clauseHits.recent.shift()!;
          const count = clauseHits.counts.get(expired.atom)! - 1;
          if (count === 0) clauseHits.counts.delete(expired.atom);
          else clauseHits.counts.set(expired.atom, count);
        }
        const first = clauseHits.recent[0]!;
        const quality =
          clauseHits.counts.size * 1000 - (hit.position - first.position);
        if (!clauseHits.best || quality > clauseHits.best.quality) {
          clauseHits.best = {
            quality,
            range: { start: first.start, end: hit.end },
          };
        }
      }
      const length = scan(text ?? "", recordBodyHit, cacheText);
      const lengthPenalty = 1 + Math.log1p(length) / 12;
      const branchScores = branches.map(() => 0);
      let literalRank = 0;
      let winningScore = -1;
      let winningClause = 0;
      for (const [clauseIndex, { branch, atomIds }] of clauses.entries()) {
        const satisfied = atomIds.every((index) => {
          const found = names[index]! + body[index]! > 0;
          return atoms[index]!.excluded ? !found : found;
        });
        if (!satisfied) continue;
        let score = 0;
        for (const index of atomIds) {
          if (atoms[index]!.excluded) continue;
          const frequency =
            Math.log1p(Math.min(8, names[index]!)) * 4 +
            Math.log1p(Math.min(8, body[index]!));
          score += frequency * (atoms[index]!.phrase ? 2 : 1);
        }
        // Bound the effect of repetitions; prefer compact, informative matches.
        score /= lengthPenalty;
        const best = windows[clauseIndex]!.best;
        if (best) score += best.quality / 1000;
        if (branch === literalBranch) literalRank = score;
        else branchScores[branch] = Math.max(branchScores[branch]!, score);
        if (score > winningScore) {
          winningScore = score;
          winningClause = clauseIndex;
        }
      }

      if (winningScore < 0) return null;

      const rank = branchScores.reduce((sum, score) => sum + score, 0);
      const best = windows[winningClause]!.best;
      return {
        // Do not count the literal alternative a second time when it is
        // just another spelling of the same match.
        rank: Math.max(rank, literalRank),
        excerpt: text && best ? excerpt(text, best.range, winningClause) : null,
      };
    },
  };
}

export function matchDocuments(
  matcher: ReturnType<typeof createDocumentMatcher>,
  documents: readonly SearchDocument[],
  { signal, cacheText }: { signal?: AbortSignal; cacheText?: boolean } = {},
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const { id, name, text } of documents) {
    signal?.throwIfAborted();
    const found = matcher.match(name, text, cacheText);
    if (found) matches.push({ id, ...found });
  }
  return matches;
}
