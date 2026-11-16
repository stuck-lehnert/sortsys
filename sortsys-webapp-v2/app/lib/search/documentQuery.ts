import { stemmer as germanStemmer } from "@orama/stemmers/german";
import { stemmer as englishStemmer } from "@orama/stemmers/english";

export type TextRange = { start: number; end: number };
export type DocumentExcerpt = { text: string; highlights: TextRange[] };
export type DocumentMatch = { rank: number; excerpt: DocumentExcerpt | null };
type Word = { plain: string; german: string; english: string };
type Token = Word & TextRange & { position: number };
type Atom = { words: Word[]; phrase: boolean; excluded: boolean };
type Hit = TextRange & { atom: number; position: number };

const wordPattern = () => /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;

/** Search semantics belong to the local query provider. The UI must not filter
 * its results again. No index, query or excerpt is sent to the API. */
export function createDocumentMatcher(query: string) {
  if (query.length > 1000) throw new RangeError("Document query is too long");
  const cache = new Map<string, Word>();
  function word(input: string): Word {
    const plain = input.normalize("NFKC").toLowerCase();
    const known = cache.get(plain);
    if (known) return known;
    // Identifiers and malformed giant words need no linguistic processing.
    const result =
      plain.length > 256
        ? { plain, german: plain, english: plain }
        : {
            plain,
            german: germanStemmer(plain),
            english: englishStemmer(plain),
          };
    if (plain.length <= 256) {
      if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
      cache.set(plain, result);
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
      if (!group.length) continue;
      clauses.at(-1)!.push(atoms.length);
      atoms.push({ words: group, phrase, excluded });
    }
  }
  const activeClauses = clauses.filter((clause) => clause.length);
  const phraseLength = Math.max(1, ...atoms.map((atom) => atom.words.length));

  function matches(token: Word, term: Word, phrase: boolean): boolean {
    if (token.plain === term.plain) return true;
    if (!phrase && token.plain.startsWith(term.plain)) return true;
    return token.german === term.german || token.english === term.english;
  }

  function scan(text: string, hit: (value: Hit) => void): number {
    const recent: Token[] = [];
    let position = 0;
    for (const match of text.matchAll(wordPattern())) {
      const current: Token = {
        ...word(match[0]),
        start: match.index,
        end: match.index + match[0].length,
        position: position++,
      };
      recent.push(current);
      if (recent.length > phraseLength) recent.shift();
      for (let index = 0; index < atoms.length; index++) {
        const atom = atoms[index]!;
        if (!matches(current, atom.words.at(-1)!, atom.phrase)) continue;
        if (atom.words.length > recent.length) continue;
        const start = recent.length - atom.words.length;
        if (
          !atom.words.every((term, offset) =>
            matches(recent[start + offset]!, term, atom.phrase),
          )
        )
          continue;
        hit({
          atom: index,
          position: current.position,
          start: recent[start]!.start,
          end: current.end,
        });
      }
    }
    return position;
  }

  function excerpt(text: string, anchor: TextRange): DocumentExcerpt | null {
    if (!text) return null;
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
      if (!atoms[hit.atom]!.excluded)
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
    hasTerms: activeClauses.length > 0,
    match(name: string, text: string | null): DocumentMatch | null {
      if (!activeClauses.length) return null;
      const names = atoms.map(() => 0);
      const body = atoms.map(() => 0);
      scan(name, (hit) => names[hit.atom]!++);
      const recent: Hit[] = [];
      let best: TextRange = { start: 0, end: 0 };
      let quality = -1;
      const length = scan(text ?? "", (hit) => {
        body[hit.atom]!++;
        if (atoms[hit.atom]!.excluded) return;
        recent.push(hit);
        while (recent.length > 256 || hit.position - recent[0]!.position > 60)
          recent.shift();
        const distinct = new Set(recent.map((value) => value.atom)).size;
        const currentQuality =
          distinct * 1000 - (hit.position - recent[0]!.position);
        if (currentQuality > quality) {
          quality = currentQuality;
          best = { start: recent[0]!.start, end: hit.end };
        }
      });
      let rank = -1;
      for (const clause of activeClauses) {
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
        score /= 1 + Math.log1p(length) / 12;
        if (quality >= 0) score += quality / 1000;
        rank = Math.max(rank, score);
      }
      if (rank < 0) return null;
      return { rank, excerpt: excerpt(text ?? "", best) };
    },
  };
}
