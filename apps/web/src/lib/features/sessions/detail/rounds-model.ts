import {
  deriveSessionRounds,
  type SessionDetail,
  type SessionDetailChildEvidence,
  type SessionDetailCostKind,
  type SessionDetailCoverageFact,
  type SessionDetailCoverageReason,
  type SessionDetailInteractionKind,
  type SessionDetailPrompt,
  type SessionDetailRoundKind,
  type SessionDetailTokenCounts,
} from '@ai-usage/report-core/session-detail';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';

/** A child session as the panel shows it: the link's evidence plus the canonical report row when it is loaded. */
export interface ChildView {
  readonly agentType: string | null;
  readonly evidence: SessionDetailChildEvidence;
  readonly label: string | null;
  /** The child's own report row (usage counted once, ADR 0018); null while its member page is not loaded. */
  readonly row: SessionPresentationRow | null;
  readonly sourceSessionId: string;
  /** Round ordinal (0-based) that launched the child; null when the harness did not record it. */
  readonly spawnRoundIndex: number | null;
}

export interface InteractionView {
  readonly at: string;
  readonly child: ChildView | null;
  readonly kind: SessionDetailInteractionKind;
  readonly label: string | null;
  readonly toolUseId: string;
}

export interface RoundView {
  readonly calls: number | null;
  readonly cost: number | null;
  readonly costKind: SessionDetailCostKind;
  readonly endAt: string;
  /** First prompt, normalised to one line, for the rail. */
  readonly excerpt: string;
  readonly id: string;
  readonly index: number;
  readonly interactions: readonly InteractionView[];
  readonly kind: SessionDetailRoundKind;
  readonly model: string;
  readonly observedSpanMs: number;
  readonly prompts: readonly SessionDetailPrompt[];
  readonly recordedActiveMs: number | null;
  readonly startAt: string;
  readonly tokens: SessionDetailTokenCounts;
  readonly tools: number;
}

export interface CoverageNote {
  readonly key: string;
  readonly text: string;
  readonly tone: 'neutral' | 'warning';
}

export interface RoundsView {
  readonly children: readonly ChildView[];
  readonly coverageNotes: readonly CoverageNote[];
  /**
   * Whether the harness records which round launched or messaged a child.
   * When it does not, an empty interaction list is a gap, not evidence of no
   * launches (ADR 0017), and the reader must say so.
   */
  readonly interactionEvidence: 'recorded' | 'unavailable';
  readonly rounds: readonly RoundView[];
  /** Interactions the reader could not attach to a round; they stay listed (ADR 0017). */
  readonly unattributedInteractions: readonly InteractionView[];
  /** Children whose launching round is unknown; they stay listed beside the rounds. */
  readonly unroundedChildren: readonly ChildView[];
}

const EXCERPT_LIMIT = 160;
const DEFAULT_OPENING_LINES = 14;
const DEFAULT_OPENING_CHARS = 1400;

export const promptExcerpt = (text: string, limit = EXCERPT_LIMIT): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
};

/**
 * The opening block of a long prompt; the reader expands to the whole text on
 * request. Both bounds apply: a one-line wall of text is as long as a list.
 */
export const promptOpening = (
  text: string,
  maxLines = DEFAULT_OPENING_LINES,
  maxChars = DEFAULT_OPENING_CHARS,
): { text: string; truncated: boolean } => {
  const lines = text.split('\n');
  const opening = lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
  if (opening.length <= maxChars) {
    return { text: opening.trimEnd(), truncated: opening.length < text.length };
  }
  const cut = opening.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  return { text: (boundary > maxChars / 2 ? cut.slice(0, boundary) : cut).trimEnd(), truncated: true };
};

const reasonTexts: Record<SessionDetailCoverageReason, string> = {
  'ancestry-budget': 'some nested records exceeded the resolution budget',
  'ancestry-conflict': 'some records were written twice with different parents',
  'ancestry-cycle': 'some records form a cycle',
  'child-budget': 'more child sessions than the panel can list',
  'child-metadata-unreadable': 'some agent sidecar files could not be read',
  'child-result-missing': 'some launches never recorded which agent they started',
  'harness-no-child-evidence': 'this harness records no child sessions',
  'harness-no-spawn-evidence': 'this harness does not record which round launched a child',
  'interaction-budget': 'more interactions than the panel can list',
  'prompt-body-budget': 'some prompt bodies exceeded the text budget',
  'prompt-budget': 'more prompts than the panel can list',
  'record-budget': 'the transcript exceeded the record budget',
  'timing-not-recorded': 'the harness did not record active time',
  'timing-rejected': 'some recorded timings were rejected as inconsistent',
  'turn-budget': 'more rounds than the panel can list',
  'unattributed-activity': 'some activity could not be attributed to a prompt',
};

const factNote = (key: string, subject: string, fact: SessionDetailCoverageFact): CoverageNote | null => {
  if (fact.status === 'complete' || fact.reasons.length === 0) {
    return null;
  }
  const reasons = fact.reasons.map((reason) => reasonTexts[reason]).join('; ');
  const omitted = fact.omittedCount === null || fact.omittedCount === 0 ? '' : ` (${fact.omittedCount} omitted)`;
  return {
    key,
    text: `${subject}: ${reasons}${omitted}.`,
    tone: fact.status === 'unavailable' ? 'warning' : 'neutral',
  };
};

const coverageNotesFor = (detail: SessionDetail): CoverageNote[] => {
  const { coverage } = detail;
  const candidates = [
    factNote('grouping', 'Rounds are partial', coverage.grouping),
    factNote('promptBodies', 'Prompt text is partial', coverage.promptBodies),
    factNote('recordedTiming', 'Recorded time is partial', coverage.recordedTiming),
    factNote('childDiscovery', 'Child sessions are partial', coverage.childDiscovery),
    factNote('interactionAttribution', 'Launches are partially attributed', coverage.interactionAttribution),
  ];
  return candidates.filter((note): note is CoverageNote => note !== null);
};

/**
 * The reading view of a session: rounds in order, each with its prompts and
 * the child sessions it launched or messaged, joined to the campaign member
 * rows the report already serves. Nothing here re-prices or re-sums: numbers
 * come from the validated turns and from the members' own rows.
 */
export const buildRoundsView = (detail: SessionDetail, memberRows: readonly SessionPresentationRow[]): RoundsView => {
  const rowsBySourceSession = new Map<string, SessionPresentationRow>();
  for (const row of memberRows) {
    const sourceSessionId = row.source?.sourceSessionId;
    if (sourceSessionId && !rowsBySourceSession.has(sourceSessionId)) {
      rowsBySourceSession.set(sourceSessionId, row);
    }
  }
  const rounds = deriveSessionRounds(detail);
  const roundIndexByTurn = new Map(rounds.map((round) => [round.turnIndex, round.index]));
  const children = detail.children.map(
    (child): ChildView => ({
      agentType: child.agentType,
      evidence: child.evidence,
      label: child.label,
      row: rowsBySourceSession.get(child.sourceSessionId) ?? null,
      sourceSessionId: child.sourceSessionId,
      spawnRoundIndex: child.spawnTurnIndex === null ? null : (roundIndexByTurn.get(child.spawnTurnIndex) ?? null),
    }),
  );
  const childrenById = new Map(children.map((child) => [child.sourceSessionId, child]));
  const promptsById = new Map(detail.prompts.map((prompt) => [prompt.id, prompt]));
  const interactionViews = detail.interactions.map(
    (interaction): InteractionView => ({
      at: interaction.at,
      child:
        interaction.childSourceSessionId === null ? null : (childrenById.get(interaction.childSourceSessionId) ?? null),
      kind: interaction.kind,
      label: interaction.label,
      toolUseId: interaction.toolUseId,
    }),
  );
  const roundViews = rounds.map((round): RoundView => {
    const prompts = round.promptIds.flatMap((id) => {
      const prompt = promptsById.get(id);
      return prompt ? [prompt] : [];
    });
    const firstText = prompts.find((prompt) => prompt.text.length > 0)?.text ?? '';
    return {
      calls: round.calls,
      cost: round.cost,
      costKind: round.costKind,
      endAt: round.endAt,
      excerpt: firstText ? promptExcerpt(firstText) : '',
      id: round.id,
      index: round.index,
      interactions: round.interactionIndexes.flatMap((index) => {
        const view = interactionViews[index];
        return view ? [view] : [];
      }),
      kind: round.kind,
      model: round.model,
      observedSpanMs: round.observedSpanMs,
      prompts,
      recordedActiveMs: round.recordedActiveMs,
      startAt: round.startAt,
      tokens: round.tokens,
      tools: round.tools,
    };
  });
  const attached = new Set(rounds.flatMap((round) => round.interactionIndexes));
  return {
    children,
    coverageNotes: coverageNotesFor(detail),
    interactionEvidence: detail.coverage.interactionAttribution.status === 'unavailable' ? 'unavailable' : 'recorded',
    rounds: roundViews,
    unattributedInteractions: interactionViews.filter((_, index) => !attached.has(index)),
    unroundedChildren: children.filter((child) => child.spawnRoundIndex === null),
  };
};

export const roundTitle = (round: Pick<RoundView, 'excerpt' | 'index' | 'kind'>): string => {
  if (round.excerpt) {
    return round.excerpt;
  }
  return round.kind === 'unattributed' ? 'Activity without a prompt' : `Round ${round.index + 1}`;
};

export const interactionTitle = (interaction: InteractionView): string => {
  const who = interaction.child?.label ?? interaction.label ?? interaction.child?.sourceSessionId ?? 'an agent';
  if (interaction.kind === 'spawn') {
    return `Launched ${who}`;
  }
  const origin =
    interaction.child?.spawnRoundIndex === null || interaction.child?.spawnRoundIndex === undefined
      ? ''
      : ` · launched in round ${interaction.child.spawnRoundIndex + 1}`;
  return `Message to ${who}${origin}`;
};
