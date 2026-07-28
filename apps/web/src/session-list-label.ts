export const SESSION_LIST_LABEL_MAX_CODE_POINTS = 200;

const REGEXP_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

export interface CaseInsensitiveLiteralMatch {
  end: number;
  start: number;
}

const literalPattern = (query: string, global: boolean): RegExp =>
  new RegExp(query.replace(REGEXP_SPECIAL_CHARACTERS, '\\$&'), global ? 'giu' : 'iu');

export const firstCaseInsensitiveLiteralMatch = (text: string, query: string): CaseInsensitiveLiteralMatch | null => {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return null;
  }
  const match = literalPattern(normalizedQuery, false).exec(text);
  return match ? { end: match.index + match[0].length, start: match.index } : null;
};

export const caseInsensitiveLiteralMatches = (text: string, query: string): CaseInsensitiveLiteralMatch[] => {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }
  return [...text.matchAll(literalPattern(normalizedQuery, true))].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
  }));
};

const prefixBoundedSessionListLabel = (codePoints: readonly string[]): string =>
  `${codePoints.slice(0, SESSION_LIST_LABEL_MAX_CODE_POINTS - 1).join('')}…`;

export const boundedSessionListLabel = (label: string, query = ''): string => {
  const codePoints = [...label];
  if (codePoints.length <= SESSION_LIST_LABEL_MAX_CODE_POINTS) {
    return label;
  }
  const match = firstCaseInsensitiveLiteralMatch(label, query);
  if (!match) {
    return prefixBoundedSessionListLabel(codePoints);
  }
  const matchStart = [...label.slice(0, match.start)].length;
  const matchEnd = [...label.slice(0, match.end)].length;
  const matchLength = matchEnd - matchStart;
  const contentCapacity = SESSION_LIST_LABEL_MAX_CODE_POINTS - 2;
  if (matchLength > contentCapacity) {
    return prefixBoundedSessionListLabel(codePoints);
  }
  const surroundingCapacity = contentCapacity - matchLength;
  let windowStart = Math.max(0, matchStart - Math.floor(surroundingCapacity / 2));
  const windowEnd = Math.min(codePoints.length, windowStart + contentCapacity);
  if (windowEnd - windowStart < contentCapacity) {
    windowStart = Math.max(0, windowEnd - contentCapacity);
  }
  return `${windowStart > 0 ? '…' : ''}${codePoints.slice(windowStart, windowEnd).join('')}${
    windowEnd < codePoints.length ? '…' : ''
  }`;
};
