import type {
  MemorySearchMatchExplanation,
  MemorySearchMatchField,
  MemorySearchMatchingMode,
} from '@ai-usage/memory-service/search';
import { memorySearchBounds } from '@ai-usage/memory-service/search';

const stopWords = new Set([
  'a',
  'an',
  'and',
  'au',
  'aux',
  'avec',
  'can',
  'ce',
  'ces',
  'dans',
  'de',
  'des',
  'du',
  'en',
  'et',
  'for',
  'from',
  'in',
  'is',
  'la',
  'le',
  'les',
  'of',
  'on',
  'or',
  'pour',
  'que',
  'qui',
  'same',
  'the',
  'to',
  'un',
  'une',
  'with',
]);

const tokenPattern = /[\p{L}\p{N}][\p{L}\p{N}_./:-]*/gu;

export interface CompiledMemorySearchQuery {
  readonly lexicalFtsQuery: string;
  readonly literal: string;
  readonly matchingMode: MemorySearchMatchingMode;
  readonly normalizedLiteral: string;
  readonly sourceTerms: readonly string[];
  readonly terms: readonly string[];
  readonly trigramFtsQuery: string;
  readonly trigrams: readonly string[];
}

export interface MemorySearchTextFields {
  readonly guidance: string;
  readonly structuredContent: string;
  readonly summary: string;
  readonly title: string;
}

export const normalizeMemorySearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('und');

const ftsQuoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const trigramsFor = (term: string): readonly string[] => {
  const characters = [...term];
  if (characters.length < 3) {
    return [];
  }
  const trigrams: string[] = [];
  for (let index = 0; index <= characters.length - 3; index += 1) {
    trigrams.push(characters.slice(index, index + 3).join(''));
  }
  return trigrams;
};

export const compileMemorySearchQuery = (
  query: string,
  matchingMode: MemorySearchMatchingMode,
): CompiledMemorySearchQuery => {
  const normalizedLiteral = normalizeMemorySearchText(query);
  const sourceMatches = query.toLocaleLowerCase('und').match(tokenPattern) ?? [];
  const matches = normalizedLiteral.match(tokenPattern) ?? [];
  const meaningful = matches.filter((term) => term.length >= 2 && !stopWords.has(term));
  const fallback = matches.filter((term) => term.length >= 2);
  const terms = Object.freeze(
    [...new Set(meaningful.length > 0 ? meaningful : fallback)].slice(0, memorySearchBounds.maxQueryTerms),
  );
  const trigrams = Object.freeze([...new Set(terms.flatMap(trigramsFor))].slice(0, 96));
  const meaningfulSourceTerms = sourceMatches.filter(
    (term) => term.length >= 2 && !stopWords.has(normalizeMemorySearchText(term)),
  );
  const fallbackSourceTerms = sourceMatches.filter((term) => term.length >= 2);
  const sourceTerms = Object.freeze(
    [...new Set(meaningfulSourceTerms.length > 0 ? meaningfulSourceTerms : fallbackSourceTerms)].slice(
      0,
      memorySearchBounds.maxQueryTerms,
    ),
  );
  const lexicalFtsQuery = terms.map((term) => `${ftsQuoted(term)}*`).join(' OR ');
  const trigramFtsQuery = trigrams.map(ftsQuoted).join(' OR ');
  return Object.freeze({
    lexicalFtsQuery,
    literal: query,
    matchingMode,
    normalizedLiteral,
    sourceTerms,
    terms,
    trigramFtsQuery,
    trigrams,
  });
};

const excerptAround = (value: string, needle: string): string => {
  const normalized = normalizeMemorySearchText(value);
  const matchIndex = normalized.indexOf(needle);
  const start = Math.max(0, matchIndex < 0 ? 0 : matchIndex - 96);
  const end = Math.min(value.length, start + memorySearchBounds.maxExplanationExcerptCharacters);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  return `${prefix}${value.slice(start, end).trim()}${suffix}`;
};

const explanationForField = (
  field: MemorySearchMatchField,
  value: string,
  compiled: CompiledMemorySearchQuery,
): MemorySearchMatchExplanation | null => {
  const normalized = normalizeMemorySearchText(value);
  if (normalized.includes(compiled.normalizedLiteral)) {
    return { excerpt: excerptAround(value, compiled.normalizedLiteral), field, kind: 'exact' };
  }
  const exactTerm = compiled.terms.find((term) => normalized.includes(term));
  if (exactTerm) {
    return { excerpt: excerptAround(value, exactTerm), field, kind: 'lexical' };
  }
  const prefix = compiled.terms.find((term) =>
    normalized
      .match(tokenPattern)
      ?.some((candidate) => candidate.startsWith(term.slice(0, Math.max(3, term.length - 2)))),
  );
  if (prefix) {
    return { excerpt: excerptAround(value, prefix.slice(0, 3)), field, kind: 'prefix' };
  }
  const fuzzyTrigram = compiled.trigrams.find((trigram) => normalized.includes(trigram));
  return fuzzyTrigram ? { excerpt: excerptAround(value, fuzzyTrigram), field, kind: 'fuzzy' } : null;
};

export const explainMemorySearchMatch = (
  fields: MemorySearchTextFields,
  compiled: CompiledMemorySearchQuery,
): readonly MemorySearchMatchExplanation[] =>
  Object.freeze(
    (
      [
        ['title', fields.title],
        ['summary', fields.summary],
        ['guidance', fields.guidance],
        ['structured-content', fields.structuredContent],
      ] as const
    )
      .map(([field, value]) => explanationForField(field, value, compiled))
      .filter((value): value is MemorySearchMatchExplanation => value !== null)
      .slice(0, memorySearchBounds.maxExplanationsPerResult),
  );

export const truncateMemorySearchGuidance = (guidance: readonly string[]): readonly string[] =>
  Object.freeze(
    guidance
      .slice(0, memorySearchBounds.maxGuidanceItemsPerResult)
      .map((entry) => entry.slice(0, memorySearchBounds.maxGuidanceCharacters)),
  );

export const normalizeMemorySearchScore = (value: number): number =>
  Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
