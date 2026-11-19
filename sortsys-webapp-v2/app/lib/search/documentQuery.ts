import { stemmer as germanStemmer } from "@orama/stemmers/german";
import { stemmer as englishStemmer } from "@orama/stemmers/english";

export type TextRange = { start: number; end: number };
export type DocumentExcerpt = { text: string; highlights: TextRange[] };
export type DocumentMatch = { rank: number; excerpt: DocumentExcerpt | null };
export type SearchDocument = { id: string; name: string; text: string | null };
export type SearchMatch = DocumentMatch & { id: string };
type Word = { plain: string; german: string; english: string };
type Atom = {
  lastWord: Word;
  precedingWords: Word[];
  phrase: boolean;
  excluded: boolean;
  clause: number;
};
type Hit = TextRange & { atom: number; position: number };
type ClauseHits = {
  recent: Hit[];
  counts: Map<number, number>;
  best: { quality: number; range: TextRange } | null;
};

const wordPattern = () => /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;

/** Search semantics belong to the local query provider. The UI must not filter
 * its results again. No index, query or excerpt is sent to the API. */
export function createDocumentMatcher(query: string) {
  if (query.length > 1000) throw new RangeError("Document query is too long");
  const cache = new Map<string, Word>();
  function word(input: string): Word {
    const known = cache.get(input);
    if (known) return known;
    const plain = input.normalize("NFKC").toLowerCase();
    // Identifiers and malformed giant words need no linguistic processing.
    const result =
      plain.length > 256
        ? { plain, german: plain, english: plain }
        : {
            plain,
            german: germanStemmer(plain),
            english: englishStemmer(plain),
          };
    if (input.length <= 256 && plain.length <= 256) {
      if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
      cache.set(input, result);
    }
    return result;
  }
  const atoms: Atom[] = [];
  const clauses: number[][] = [[]];
  for (const match of query.matchAll(/-?"[^"]*(?:"|$)|[^\s"]+/gu)) {
    const input = match[0];
    if (input.toUpperCase() === "OR") {
      if (clauses.at(-1)!.length) clauses.push([]);
      continue;
    }
    const excluded = input.startsWith("-");
    const text = excluded ? input.slice(1) : input;
    const phrase = text.startsWith('"');
    const words = [...text.matchAll(wordPattern())].map((value) =>
      word(value[0]),
    );
    const groups = phrase ? [words] : words.map((value) => [value]);
    for (const group of groups) {
      const lastWord = group.pop();
      if (!lastWord) continue;
      clauses.at(-1)!.push(atoms.length);
      atoms.push({
        lastWord,
        precedingWords: group,
        phrase,
        excluded,
        clause: clauses.length - 1,
      });
    }
  }
  if (!clauses.at(-1)!.length) clauses.pop();
  const precedingWordLimit = Math.max(
    0,
    ...atoms.map((atom) => atom.precedingWords.length),
  );

  function matches(token: Word, term: Word, phrase: boolean): boolean {
    if (token.plain === term.plain) return true;
    if (!phrase && token.plain.startsWith(term.plain)) return true;
    return token.german === term.german || token.english === term.english;
  }

  function scan(text: string, hit: (value: Hit) => void): number {
    const preceding: { word: Word; start: number }[] = [];
    let position = 0;
    for (const match of text.matchAll(wordPattern())) {
      const current = word(match[0]);
      for (let index = 0; index < atoms.length; index++) {
        const atom = atoms[index]!;
        if (!matches(current, atom.lastWord, atom.phrase)) continue;
        let start = match.index;
        if (atom.precedingWords.length) {
          const first = preceding.length - atom.precedingWords.length;
          if (
            first < 0 ||
            !atom.precedingWords.every((term, offset) =>
              matches(preceding[first + offset]!.word, term, true),
            )
          ) {
            continue;
          }
          start = preceding[first]!.start;
        }
        hit({
          atom: index,
          position,
          start,
          end: match.index + match[0].length,
        });
      }
      if (precedingWordLimit) {
        preceding.push({ word: current, start: match.index });
        if (preceding.length > precedingWordLimit) preceding.shift();
      }
      position++;
    }
    return position;
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
    match(name: string, text: string | null): DocumentMatch | null {
      if (!clauses.length) return null;
      const names = atoms.map(() => 0);
      const body = atoms.map(() => 0);
      const windows = clauses.map<ClauseHits>(() => ({
        recent: [],
        counts: new Map(),
        best: null,
      }));
      scan(name, (hit) => names[hit.atom]!++);
      const length = scan(text ?? "", (hit) => {
        body[hit.atom]!++;
        const atom = atoms[hit.atom]!;
        if (atom.excluded) return;
        const clauseHits = windows[atom.clause]!;
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
      });
      const lengthPenalty = 1 + Math.log1p(length) / 12;
      let rank = -1;
      let winningClause = 0;
      for (const [clauseIndex, clause] of clauses.entries()) {
        const satisfied = clause.every((index) => {
          const found = names[index]! + body[index]! > 0;
          return atoms[index]!.excluded ? !found : found;
        });
        if (!satisfied) continue;
        let score = 0;
        for (const index of clause) {
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
        if (score > rank) {
          rank = score;
          winningClause = clauseIndex;
        }
      }
      if (rank < 0) return null;
      const best = windows[winningClause]!.best;
      return {
        rank,
        excerpt: text && best ? excerpt(text, best.range, winningClause) : null,
      };
    },
  };
}

export function matchDocuments(
  matcher: ReturnType<typeof createDocumentMatcher>,
  documents: SearchDocument[],
  signal?: AbortSignal,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const { id, name, text } of documents) {
    signal?.throwIfAborted();
    const found = matcher.match(name, text);
    if (found) matches.push({ id, ...found });
  }
  return matches;
}
