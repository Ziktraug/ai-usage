/** The explorer consumes the bounded corpus already loaded by the prompt reader. */
export interface ExplorationPrompt {
  readonly at: string;
  readonly harness: string;
  readonly id: string;
  readonly ordinal: number;
  readonly partial: boolean;
  readonly project: string;
  readonly rowId: string;
  readonly sessionId: string;
  readonly text: string;
}

export interface PromptMotif {
  readonly entries: readonly ExplorationPrompt[];
  readonly id: string;
  readonly kind: 'exact' | 'phrase';
  readonly sessions: number;
  readonly text: string;
}

export const EXPLORATION_LIMITS = {
  candidates: 12_000,
  characters: 2000,
  motifs: 60,
  prompts: 500,
  words: 80,
} as const;
const stopWords = new Set(
  'a an and are as at be by can de des du et for from i in is it la le les of on or please que the this to un une with you'.split(
    ' ',
  ),
);
const normalize = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const commandPattern = /^\s*\/[\w-]+(?:\s|$)/u;
const segmentPattern = /[\n.!?;]+/u;

/** Separators prevent n-grams from joining text across excluded code or context. */
export const proseSegments = (text: string): string[] => {
  if (commandPattern.test(text)) {
    return [];
  }
  return text
    .slice(0, EXPLORATION_LIMITS.characters)
    .replace(
      /<(context|environment_context|ide_opened_file|ide_selection|in-app-browser-context|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/giu,
      '\n',
    )
    .replace(/```[\s\S]*?(?:```|$)/gu, '\n')
    .replace(/`[^`]*`/gu, '\n')
    .replace(/https?:\/\/\S+|(?:\/[\w.@~-]+){2,}\S*|<[^>]+>/gu, '\n')
    .split(segmentPattern)
    .map(
      (part) =>
        normalize(part)
          .match(/[\p{L}\p{N}]+/gu)
          ?.join(' ') ?? '',
    )
    .filter(Boolean);
};

export const promptIdentity = (entry: ExplorationPrompt): string => JSON.stringify([entry.rowId, entry.id]);
const uniqueSessions = (entries: readonly ExplorationPrompt[]): number =>
  new Set(entries.map((entry) => entry.rowId)).size;

export const weekOf = (at: string): string | null => {
  const value = new Date(at);
  if (!Number.isFinite(value.getTime())) {
    return null;
  }
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day);
  return value.toISOString().slice(0, 10);
};

export const analyzePrompts = (input: readonly ExplorationPrompt[]) => {
  const unique = [...new Map(input.map((entry) => [promptIdentity(entry), entry])).values()];
  const entries = unique.slice(0, EXPLORATION_LIMITS.prompts);
  const candidates = new Map<string, { text: string; kind: PromptMotif['kind']; entries: ExplorationPrompt[] }>();
  let excluded = 0;
  let clipped = 0;
  let candidateLimit = false;
  for (const entry of entries) {
    const segments = proseSegments(entry.text);
    if (!segments.length) {
      excluded += 1;
      continue;
    }
    const wordCount = segments.reduce((sum, part) => sum + part.split(' ').length, 0);
    if (entry.partial || entry.text.length > EXPLORATION_LIMITS.characters || wordCount > EXPLORATION_LIMITS.words) {
      clipped += 1;
    }
    const seen = new Set<string>();
    const add = (text: string, kind: PromptMotif['kind']): void => {
      const id = `${kind}:${text}`;
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      const existing = candidates.get(id);
      if (existing) {
        existing.entries.push(entry);
      } else if (candidates.size < EXPLORATION_LIMITS.candidates) {
        candidates.set(id, { entries: [entry], kind, text });
      } else {
        candidateLimit = true;
      }
    };
    if (segments.length === 1 && wordCount <= 35 && !entry.partial) {
      add(segments[0] ?? '', 'exact');
    }
    let remaining = EXPLORATION_LIMITS.words;
    for (const segment of segments) {
      const words = segment.split(' ').slice(0, remaining);
      remaining -= words.length;
      for (let size = 3; size <= 7; size += 1) {
        for (let start = 0; start + size <= words.length; start += 1) {
          const part = words.slice(start, start + size);
          if (stopWords.has(part[0] ?? '') || stopWords.has(part.at(-1) ?? '')) {
            continue;
          }
          if (part.filter((word) => word.length > 2 && !stopWords.has(word)).length < 2) {
            continue;
          }
          add(part.join(' '), 'phrase');
        }
      }
    }
  }
  const motifs = [...candidates]
    .map(([id, value]) => ({ ...value, id, sessions: uniqueSessions(value.entries) }))
    .filter((motif) => motif.sessions >= (motif.kind === 'exact' ? 2 : 4))
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        (left.kind === 'exact' ? -1 : 1) - (right.kind === 'exact' ? -1 : 1) ||
        left.text.localeCompare(right.text),
    )
    .filter(
      (motif, index, all) =>
        !all.slice(0, index).some((other) => other.text.includes(motif.text) && other.sessions === motif.sessions),
    )
    .slice(0, EXPLORATION_LIMITS.motifs);
  const weeks = [...new Set(entries.map((entry) => weekOf(entry.at)).filter((week): week is string => week !== null))]
    .sort()
    .map((name) => {
      const members = entries.filter((entry) => weekOf(entry.at) === name);
      return { name, prompts: members.length, sessions: uniqueSessions(members) };
    });
  return {
    analyzed: entries.length,
    candidateLimit,
    clipped,
    entries,
    excluded,
    motifs,
    omitted: unique.length - entries.length,
    sessions: uniqueSessions(entries),
    weeks,
  };
};

export const followingPrompts = (
  entry: ExplorationPrompt,
  entries: readonly ExplorationPrompt[],
): ExplorationPrompt[] => {
  const byOrdinal = new Map(
    entries.filter((candidate) => candidate.rowId === entry.rowId).map((candidate) => [candidate.ordinal, candidate]),
  );
  const following: ExplorationPrompt[] = [];
  for (let ordinal = entry.ordinal + 1; ordinal <= entry.ordinal + 3; ordinal += 1) {
    const candidate = byOrdinal.get(ordinal);
    if (!candidate) {
      break;
    }
    following.push(candidate);
  }
  return following;
};

export const entryBreakdown = (matches: readonly ExplorationPrompt[], entries: readonly ExplorationPrompt[]) => {
  const projects = [...new Set(entries.map((entry) => entry.project))].sort().map((name) => ({
    matched: uniqueSessions(matches.filter((entry) => entry.project === name)),
    name,
    total: uniqueSessions(entries.filter((entry) => entry.project === name)),
  }));
  const weeks = [...new Set(entries.map((entry) => weekOf(entry.at)).filter((week): week is string => week !== null))]
    .sort()
    .map((name) => ({
      matched: uniqueSessions(matches.filter((entry) => weekOf(entry.at) === name)),
      name,
      total: uniqueSessions(entries.filter((entry) => weekOf(entry.at) === name)),
    }));
  return { projects, weeks };
};
export const motifBreakdown = (motif: PromptMotif, entries: readonly ExplorationPrompt[]) =>
  entryBreakdown(motif.entries, entries);

export const explorationDraft = (motif: PromptMotif, revision: string, notes: string, corpusScope = ''): string =>
  [
    '# Prompt observation',
    `Report revision: ${revision}`,
    `Corpus filters: ${corpusScope || 'Not specified'}`,
    `Formulation: ${motif.text}`,
    `Observed in ${motif.sessions} distinct loaded sessions. This is a bounded sample, not a success measure.`,
    '\n## Sources',
    ...motif.entries.map((entry) => `- ${entry.at} · ${entry.project} · ${entry.rowId} · ${entry.id}`),
    '\n## Question to investigate',
    notes,
    '\nNo agent configuration or source history was changed.',
  ].join('\n');
