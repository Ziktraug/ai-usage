import { type ExplorationPrompt, followingPrompts, promptIdentity } from './prompt-exploration';
import type { SemanticFamily } from './semantic-model';

/** Editorial suggestions over current formulations, never private snapshot IDs. */
export const PRACTICES = [
  {
    id: 'review',
    title: 'Ask for a code review',
    description: 'Recognized review, audit or relecture vocabulary.',
    pattern: /\b(review|audit|relire|relecture)\b/u,
  },
  {
    id: 'fix',
    title: 'Ask for corrections',
    description: 'Recognized fix, repair or correction vocabulary.',
    pattern: /\b(fix|repair|corrige|corriger|correction|correctifs?)\b/u,
  },
  {
    id: 'feedback',
    title: 'Ask for an opinion',
    description: 'Recognized feedback, opinion or avis vocabulary.',
    pattern: /\b(feedback|opinion|avis|penses)\b/u,
  },
  {
    id: 'ship',
    title: 'Ask for a commit or push',
    description: 'Recognized commit, push or delivery vocabulary; no delivery inferred.',
    pattern: /\b(commit|push|livrer|livraison)\b/u,
  },
  {
    id: 'handoff',
    title: 'Prepare another session',
    description: 'Recognized handoff or new-session vocabulary.',
    pattern: /\b(handoff|nouvelle session|new session|passage de relais)\b/u,
  },
  {
    id: 'status',
    title: 'Ask for a progress update',
    description: 'Recognized recap, progress or status vocabulary.',
    pattern: /\b(recap|status|progress|point d etape|avancement)\b/u,
  },
  {
    id: 'continue',
    title: 'Ask to continue',
    description: 'Recognized continuation vocabulary; its meaning depends on context.',
    pattern: /\b(continue|continuer|poursuis|poursuivre)\b/u,
  },
] as const;
export type PracticeId = (typeof PRACTICES)[number]['id'];
export interface PracticeCase {
  readonly following: readonly ExplorationPrompt[];
  readonly nextPractice: PracticeId | null;
  readonly start: ExplorationPrompt;
}
export interface PracticeView {
  readonly cases: readonly PracticeCase[];
  readonly description: string;
  readonly families: readonly SemanticFamily[];
  readonly id: PracticeId;
  readonly title: string;
}
const negation = /\b(not|never|without|pas|jamais|sans)\b/u;

export const suggestedPractice = (text: string): PracticeId | null => {
  const normalized = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (negation.test(normalized)) {
    return null;
  }
  return PRACTICES.find((practice) => practice.pattern.test(normalized))?.id ?? null;
};

export const buildPractices = (
  families: readonly SemanticFamily[],
  entries: readonly ExplorationPrompt[],
  omitted: ReadonlySet<string> = new Set(),
): PracticeView[] =>
  PRACTICES.map((definition) => {
    const members = families.filter(
      (family) =>
        !omitted.has(`${definition.id}:${family.reference.id}`) &&
        family.members.some((member) => suggestedPractice(member.formulation.text) === definition.id),
    );
    const candidates = [
      ...new Map(
        members
          .flatMap((family) => family.members.flatMap((member) => member.formulation.entries))
          .map((entry) => [promptIdentity(entry), entry]),
      ).values(),
    ].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    const roots = [...new Map(candidates.toReversed().map((entry) => [entry.rowId, entry])).values()];
    const cases = roots.map((start) => {
      const following = followingPrompts(start, entries);
      const nextPractice =
        following.map((entry) => suggestedPractice(entry.text)).find((value) => value !== null) ?? null;
      return { following, nextPractice, start };
    });
    return {
      cases,
      description: definition.description,
      families: members,
      id: definition.id,
      title: definition.title,
    };
  });

export interface PracticeDraftSelection {
  readonly comparisonRowIds: readonly string[];
  readonly corpusScope: string;
  readonly omittedFamilies: readonly string[];
  readonly project: string;
}

export const practiceDraft = (
  practice: PracticeView,
  revision: string,
  notes: string,
  selection?: PracticeDraftSelection,
): string =>
  [
    `# ${practice.title}`,
    'Editorial grouping; not a discovered universal category.',
    `Revision: ${revision}`,
    `Corpus filters: ${selection?.corpusScope || 'Not specified'}`,
    `Project selection: ${selection?.project || 'All loaded projects'}`,
    `${practice.cases.length} distinct sessions in the loaded sample.`,
    '\n## Included families',
    ...practice.families.map((family) => `- ${family.reference.text}`),
    '\n## Excluded families',
    ...(selection?.omittedFamilies ?? []).map((id) => `- ${id}`),
    '\n## Compared sessions',
    ...(selection?.comparisonRowIds ?? []).map((id) => `- ${id}`),
    '\n## Observed sources',
    ...practice.cases.map(({ start }) => `- ${start.project} · ${start.at} · ${start.rowId} · ${start.id}`),
    '\n## Question to investigate',
    notes,
    '\nFollowing requests are observations, not evidence of success, failure or causality.',
  ].join('\n');
