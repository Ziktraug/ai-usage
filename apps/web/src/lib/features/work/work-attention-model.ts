import {
  type ClaudeDesktopTurnStatus,
  WORK_ATTENTION_KINDS,
  type WorkAttentionKind,
  type WorkFact,
  type WorkFactSource,
  type WorkRoot,
  workSessionKeyString,
} from '@ai-usage/report-core/work-attention';

/**
 * Pure presentation model for the Work resume surface: grouping, search, ordering, URL state and
 * keyboard movement. Nothing here reads a clock, the DOM or a store; the reference instant is
 * always the dataset's own `generatedAt`, so the same dataset reads the same everywhere.
 */
export interface WorkAttentionSearch {
  readonly attention: readonly WorkAttentionKind[];
  readonly harness: readonly string[];
  readonly machine: readonly string[];
  readonly project: readonly string[];
  readonly query: string;
  readonly root: string | null;
}

export const EMPTY_WORK_ATTENTION_SEARCH: WorkAttentionSearch = {
  attention: [],
  harness: [],
  machine: [],
  project: [],
  query: '',
  root: null,
};

const LIST_SEPARATOR = ',';
const MAX_QUERY_LENGTH = 200;
const MAX_LIST_VALUES = 20;
const WHITESPACE = /\s+/;

const isAttentionKind = (value: string): value is WorkAttentionKind =>
  (WORK_ATTENTION_KINDS as readonly string[]).includes(value);

const readList = (params: URLSearchParams, name: string): readonly string[] => [
  ...new Set(
    params
      .getAll(name)
      .flatMap((value) => value.split(LIST_SEPARATOR))
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, MAX_LIST_VALUES),
  ),
];

export const parseWorkAttentionSearch = (params: URLSearchParams): WorkAttentionSearch => ({
  attention: readList(params, 'attention').filter(isAttentionKind),
  harness: readList(params, 'harness'),
  machine: readList(params, 'machine'),
  project: readList(params, 'project'),
  query: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
  root: params.get('root')?.trim() || null,
});

/** Writes the search into a copy of `url`; defaults are deleted so a clean state is a clean address. */
export const writeWorkAttentionSearch = (url: URL, search: WorkAttentionSearch): URL => {
  const next = new URL(url);
  const write = (name: string, values: readonly string[]): void => {
    next.searchParams.delete(name);
    if (values.length > 0) {
      next.searchParams.set(name, values.join(LIST_SEPARATOR));
    }
  };
  next.searchParams.delete('q');
  if (search.query.trim().length > 0) {
    next.searchParams.set('q', search.query.trim());
  }
  write('attention', search.attention);
  write('harness', search.harness);
  write('machine', search.machine);
  write('project', search.project);
  next.searchParams.delete('root');
  if (search.root) {
    next.searchParams.set('root', search.root);
  }
  next.hash = '';
  return next;
};

export const sameWorkAttentionFilters = (left: WorkAttentionSearch, right: WorkAttentionSearch): boolean =>
  left.query === right.query &&
  left.attention.join(LIST_SEPARATOR) === right.attention.join(LIST_SEPARATOR) &&
  left.harness.join(LIST_SEPARATOR) === right.harness.join(LIST_SEPARATOR) &&
  left.machine.join(LIST_SEPARATOR) === right.machine.join(LIST_SEPARATOR) &&
  left.project.join(LIST_SEPARATOR) === right.project.join(LIST_SEPARATOR);

export const hasWorkAttentionFilters = (search: WorkAttentionSearch): boolean =>
  !sameWorkAttentionFilters(search, EMPTY_WORK_ATTENTION_SEARCH);

export const toggleListValue = (values: readonly string[], value: string): readonly string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

/** The address of a root: its desktop session id when it has one, otherwise its full session key. */
export const workRootId = (root: WorkRoot): string => root.desktopSessionId ?? workSessionKeyString(root.key);

/** The instant a row is dated by: the declaration first, then activity, then the last observation. */
export const workRootRelevantInstant = (root: WorkRoot): string | null =>
  root.age.declaredAt ?? root.age.lastActivityAt ?? root.age.lastObservedAt ?? root.age.createdAt;

const pullRequestFacts = (root: WorkRoot) =>
  root.facts.filter(
    (fact): fact is Extract<WorkFact, { kind: 'declared-pull-request' | 'pull-request' }> =>
      fact.kind === 'declared-pull-request' || fact.kind === 'pull-request',
  );

const jiraFacts = (root: WorkRoot) =>
  root.facts.filter((fact): fact is Extract<WorkFact, { kind: 'jira-issue' }> => fact.kind === 'jira-issue');

const searchableText = (root: WorkRoot): string =>
  [
    root.title,
    root.project.label,
    root.project.branch ?? '',
    root.project.worktreeName ?? '',
    root.declared?.needsAction ?? '',
    root.declared?.detail ?? '',
    ...pullRequestFacts(root).flatMap((fact) => [`#${fact.number}`, fact.repository]),
    ...jiraFacts(root).map((fact) => fact.key),
  ]
    .join('\n')
    .toLowerCase();

export const matchesWorkAttentionSearch = (root: WorkRoot, search: WorkAttentionSearch): boolean => {
  if (search.attention.length > 0 && !search.attention.includes(root.attention)) {
    return false;
  }
  if (search.harness.length > 0 && !search.harness.includes(root.key.harness)) {
    return false;
  }
  if (search.machine.length > 0 && !search.machine.includes(root.key.machineId)) {
    return false;
  }
  if (search.project.length > 0 && !search.project.includes(root.project.label)) {
    return false;
  }
  const tokens = search.query
    .toLowerCase()
    .split(WHITESPACE)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = searchableText(root);
  return tokens.every((token) => haystack.includes(token));
};

const compareInstantsDescending = (left: string | null, right: string | null): number => {
  const leftTime = left === null ? Number.NEGATIVE_INFINITY : Date.parse(left);
  const rightTime = right === null ? Number.NEGATIVE_INFINITY : Date.parse(right);
  return rightTime - leftTime;
};

/**
 * Most recent first; ties fall back to the title and then to the stable session key. A request a
 * later pull request may have answered (`reconsidered`) ranks after the ones nothing reconsidered.
 */
export const sortWorkRoots = (roots: readonly WorkRoot[]): readonly WorkRoot[] =>
  [...roots].sort(
    (left, right) =>
      Number(left.reconsidered) - Number(right.reconsidered) ||
      compareInstantsDescending(workRootRelevantInstant(left), workRootRelevantInstant(right)) ||
      left.title.localeCompare(right.title) ||
      workSessionKeyString(left.key).localeCompare(workSessionKeyString(right.key)),
  );

export interface WorkAttentionSection {
  /** Rows beyond this count are collapsed behind an explicit control; `null` shows everything. */
  readonly collapseBeyond: number | null;
  readonly kind: WorkAttentionKind;
  readonly note: string;
  readonly title: string;
}

export const WORK_ATTENTION_SECTIONS: readonly WorkAttentionSection[] = [
  {
    collapseBeyond: null,
    kind: 'human-request',
    note: 'Questions and review requests the sessions declared. A root marked “possibly answered” has a later pull request that may be the answer; it ranks last and stays yours until you confirm.',
    title: 'Needs you',
  },
  {
    collapseBeyond: null,
    kind: 'external-wait',
    note: 'Pull requests that were open and waiting on a review or on checks when last observed.',
    title: 'Waiting on others',
  },
  {
    collapseBeyond: null,
    kind: 'optional-lead',
    note: 'Proposals the sessions left open. Not urgent; starting one is your call.',
    title: 'Leads',
  },
  {
    collapseBeyond: 10,
    kind: 'none',
    note: 'Completed, undeclared or unsupported outcomes. Nothing pending was read here; that is not proof that nothing is pending.',
    title: 'Recent · no pending declaration read',
  },
];

export const workAttentionSectionFor = (kind: WorkAttentionKind): WorkAttentionSection =>
  WORK_ATTENTION_SECTIONS.find((section) => section.kind === kind) ?? WORK_ATTENTION_SECTIONS[3]!;

export interface WorkAttentionGroup {
  readonly roots: readonly WorkRoot[];
  readonly section: WorkAttentionSection;
}

/** Every section in display order, including empty ones, each sorted most recent first. */
export const groupWorkRoots = (roots: readonly WorkRoot[]): readonly WorkAttentionGroup[] =>
  WORK_ATTENTION_SECTIONS.map((section) => ({
    roots: sortWorkRoots(roots.filter((root) => root.attention === section.kind)),
    section,
  }));

export const filterWorkRoots = (roots: readonly WorkRoot[], search: WorkAttentionSearch): readonly WorkRoot[] =>
  roots.filter((root) => matchesWorkAttentionSearch(root, search));

export interface WorkFilterOption {
  readonly count: number;
  readonly value: string;
}

const countBy = (roots: readonly WorkRoot[], pick: (root: WorkRoot) => string): readonly WorkFilterOption[] => {
  const counts = new Map<string, number>();
  for (const root of roots) {
    const value = pick(root);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
};

export interface WorkFilterOptions {
  readonly attention: readonly WorkFilterOption[];
  readonly harness: readonly WorkFilterOption[];
  readonly machine: readonly WorkFilterOption[];
  readonly project: readonly WorkFilterOption[];
}

export const workFilterOptions = (roots: readonly WorkRoot[]): WorkFilterOptions => ({
  attention: WORK_ATTENTION_SECTIONS.map((section) => ({
    count: roots.filter((root) => root.attention === section.kind).length,
    value: section.kind,
  })),
  harness: countBy(roots, (root) => root.key.harness),
  machine: countBy(roots, (root) => root.key.machineId),
  project: countBy(roots, (root) => root.project.label),
});

/**
 * Roving focus across the flat list of visible rows. Returns the index to focus, or `null` when
 * the key is not a movement key, so callers leave every other key to the browser.
 */
export const nextWorkRowIndex = (current: number, key: string, count: number): number | null => {
  if (count <= 0) {
    return null;
  }
  switch (key) {
    case 'ArrowDown':
      return Math.min(current + 1, count - 1);
    case 'ArrowUp':
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Coarse, honest ages: minutes under an hour, hours under two days, days beyond. */
export const formatRelativeAge = (instant: string | null, reference: string): string => {
  if (instant === null) {
    return 'undated';
  }
  const elapsed = Date.parse(reference) - Date.parse(instant);
  if (!Number.isFinite(elapsed)) {
    return 'undated';
  }
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }
  if (elapsed < 2 * DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
};

const exactFormatter = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
  timeZoneName: 'short',
  year: 'numeric',
});

/** The exact instant in the reader's time zone, with the zone named so it cannot be misread. */
export const formatExactInstant = (instant: string | null): string =>
  instant === null ? 'undated' : exactFormatter.format(new Date(instant));

export const workDeclaredStatusLabel = (status: ClaudeDesktopTurnStatus): string =>
  status === 'review_ready' ? 'review ready' : status;

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

export const workHarnessLabel = (harness: string): string => HARNESS_LABELS[harness] ?? harness;

export type WorkFactChipTone = 'neutral' | 'ok' | 'warn';

export interface WorkFactChip {
  readonly id: string;
  /** The instant the chip is dated by: when the fact was listed or observed, never the pull request's own dates. */
  readonly instant: string | null;
  /** What `instant` is ("listed", "observed"); rendered before the relative age. */
  readonly instantLabel: string | null;
  readonly label: string;
  readonly tone: WorkFactChipTone;
}

const openPullRequestDetail = (fact: Extract<WorkFact, { kind: 'pull-request' }>): string => {
  if (fact.checksRollup === 'pending') {
    return 'checks pending';
  }
  return fact.reviewDecision ? fact.reviewDecision.toLowerCase().replaceAll('_', ' ') : 'awaiting review';
};

const pullRequestChips = (root: WorkRoot): readonly WorkFactChip[] => {
  const byNumber = new Map<number, WorkFactChip>();
  for (const fact of pullRequestFacts(root)) {
    if (fact.kind === 'declared-pull-request') {
      if (!byNumber.has(fact.number)) {
        // Dated by the session file that listed it, not by the pull request.
        byNumber.set(fact.number, {
          id: fact.id,
          instant: fact.provenance.observedAt,
          instantLabel: 'listed',
          label: `PR #${fact.number} ${fact.state.toLowerCase()} (declared)`,
          tone: 'neutral',
        });
      }
      continue;
    }
    if (fact.outcome !== 'observed' || fact.state === null) {
      byNumber.set(fact.number, {
        id: fact.id,
        instant: fact.provenance.observedAt,
        instantLabel: 'observed',
        label: `PR #${fact.number} read failed (${fact.outcome})`,
        tone: 'warn',
      });
      continue;
    }
    const detail = fact.state === 'OPEN' ? openPullRequestDetail(fact) : fact.state.toLowerCase();
    byNumber.set(fact.number, {
      id: fact.id,
      instant: fact.provenance.observedAt,
      instantLabel: 'observed',
      label: `PR #${fact.number} ${detail}`,
      tone: fact.state === 'MERGED' ? 'ok' : 'neutral',
    });
  }
  return [...byNumber.values()];
};

const replies = (count: number): string => `${count} new ${count === 1 ? 'reply' : 'replies'}`;

/**
 * One chip per issue key; as for pull requests, a later failed read replaces the older success in
 * the row. Dated by the newest reply when one arrived, else by the observation.
 */
const jiraChips = (root: WorkRoot): readonly WorkFactChip[] => {
  const byKey = new Map<string, WorkFactChip>();
  for (const fact of jiraFacts(root)) {
    if (fact.outcome !== 'observed') {
      byKey.set(fact.key, {
        id: fact.id,
        instant: fact.provenance.observedAt,
        instantLabel: 'observed',
        label: `Jira ${fact.key} read failed (${fact.outcome})`,
        tone: 'warn',
      });
      continue;
    }
    const arrived = fact.newCommentsSince ?? 0;
    byKey.set(fact.key, {
      id: fact.id,
      instant: fact.newestCommentAt ?? fact.provenance.observedAt,
      instantLabel: fact.newestCommentAt === null ? 'observed' : 'newest reply',
      label: `Jira ${fact.key} · ${fact.status ?? 'status unknown'}${arrived > 0 ? ` · ${replies(arrived)}` : ''}`,
      tone: arrived > 0 ? 'warn' : 'neutral',
    });
  }
  return [...byKey.values()];
};

/**
 * The pull request named first by the "possibly answered" interpretation, for the row's chip.
 * The evidence ids are resolved against the root's own facts; nothing is parsed out of text.
 */
const reconsideredPullRequestNumber = (root: WorkRoot): number | null => {
  const evidence = new Set(
    root.interpretations
      .filter(({ kind }) => kind === 'request-satisfied-elsewhere')
      .flatMap((entry) => entry.evidence),
  );
  return pullRequestFacts(root).find((fact) => evidence.has(fact.id))?.number ?? null;
};

/** The compact facts a row shows: pull requests, Jira issues, a dirty checkout, proposals and children. */
export const workRootFactChips = (root: WorkRoot): readonly WorkFactChip[] => {
  const chips: WorkFactChip[] = [];
  if (root.reconsidered) {
    const number = reconsideredPullRequestNumber(root);
    chips.push({
      id: `${workRootId(root)}:reconsidered`,
      instant: null,
      instantLabel: null,
      label: number === null ? 'possibly answered' : `possibly answered · PR #${number}`,
      tone: 'neutral',
    });
  }
  if (root.declared?.status === 'blocked' && (root.declared.needsAction?.trim() ?? '') === '') {
    // Blocked without a relayable question: nothing to ask, but not nothing pending.
    chips.push({
      id: `${workRootId(root)}:blocked-no-question`,
      instant: null,
      instantLabel: null,
      label: 'blocked · no question recorded',
      tone: 'warn',
    });
  }
  chips.push(...pullRequestChips(root), ...jiraChips(root));
  for (const fact of root.facts) {
    if (fact.kind === 'checkout-status' && fact.dirty === true) {
      chips.push({
        id: fact.id,
        instant: fact.provenance.observedAt,
        instantLabel: 'observed',
        label: `checkout dirty (${fact.modifiedCount ?? '?'} modified)`,
        tone: 'warn',
      });
    }
  }
  const proposals = root.facts.filter(
    (fact): fact is Extract<WorkFact, { kind: 'proposal' }> => fact.kind === 'proposal',
  );
  if (proposals.length > 0) {
    const open = proposals.filter((fact) => fact.resolution === 'open').length;
    chips.push({
      id: `${workRootId(root)}:proposals`,
      instant: null,
      instantLabel: null,
      label: `proposals ${open} open / ${proposals.length - open} resolved`,
      tone: 'neutral',
    });
  }
  if (root.children.count > 0) {
    chips.push({
      id: `${workRootId(root)}:children`,
      instant: null,
      instantLabel: null,
      label:
        root.children.blocked > 0
          ? `children ${root.children.count} · ${root.children.blocked} blocked`
          : `children ${root.children.count}`,
      tone: root.children.blocked > 0 ? 'warn' : 'neutral',
    });
  }
  return chips;
};

export const WORK_FACT_SOURCE_LABELS: Readonly<Record<WorkFactSource, string>> = {
  'claude-desktop': 'Claude Desktop metadata',
  'claude-transcript': 'Claude transcript',
  github: 'GitHub',
  jira: 'Jira',
  'local-checkout': 'Local checkout',
};

export interface WorkFactSourceGroup {
  readonly facts: readonly WorkFact[];
  readonly source: WorkFactSource;
}

export const groupWorkFactsBySource = (facts: readonly WorkFact[]): readonly WorkFactSourceGroup[] => {
  const groups = new Map<WorkFactSource, WorkFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.provenance.source);
    if (group) {
      group.push(fact);
    } else {
      groups.set(fact.provenance.source, [fact]);
    }
  }
  return [...groups.entries()].map(([source, grouped]) => ({ facts: grouped, source }));
};

/** One line per fact for the detail panel; the provenance is rendered beside it, not inside it. */
export const workFactSummary = (fact: WorkFact): string => {
  switch (fact.kind) {
    case 'declared-turn':
      return `Declared ${workDeclaredStatusLabel(fact.status)}: ${fact.detail}`;
    case 'declared-pull-request':
      return `Declared PR #${fact.number} ${fact.state.toLowerCase()} on ${fact.repository}${fact.branch ? ` (${fact.branch})` : ''}`;
    case 'pull-request':
      return fact.outcome === 'observed' && fact.state
        ? `PR #${fact.number} ${fact.state.toLowerCase()}${fact.draft ? ', draft' : ''}${fact.checksRollup ? `, checks ${fact.checksRollup}` : ''}${fact.reviewDecision ? `, ${fact.reviewDecision.toLowerCase().replaceAll('_', ' ')}` : ''}`
        : `PR #${fact.number} read failed: ${fact.outcome}`;
    case 'checkout-status':
      return fact.outcome === 'observed'
        ? `Checkout ${fact.checkoutPath}${fact.branch ? ` on ${fact.branch}` : ''}: ${fact.dirty ? `dirty, ${fact.modifiedCount ?? '?'} modified, ${fact.untrackedCount ?? '?'} untracked` : 'clean'}${fact.ahead ? `, ${fact.ahead} ahead` : ''}${fact.behind ? `, ${fact.behind} behind` : ''}`
        : `Checkout ${fact.checkoutPath}: ${fact.outcome}`;
    case 'jira-issue':
      return fact.outcome === 'observed'
        ? `Jira ${fact.key} ${fact.status ?? 'status unknown'}${fact.commentCount === null ? '' : `, ${fact.commentCount} comment${fact.commentCount === 1 ? '' : 's'}`}${fact.newCommentsSince ? `, ${replies(fact.newCommentsSince)} since the latest activity on this key` : ''}`
        : `Jira ${fact.key} read failed: ${fact.outcome}`;
    case 'proposal':
      return `Proposal ${fact.resolution === 'open' ? 'open' : fact.resolution.replace('_', ' ')}: ${fact.title}${fact.tldr ? ` — ${fact.tldr}` : ''}`;
    case 'wrap-up':
      return `Wrap-up: ${fact.text}`;
    case 'turn-report':
      return `Turn report: ${fact.text}`;
    case 'written-branch':
      return `Wrote branch ${fact.branch}`;
    case 'spawned-from':
      return `Spawned from ${fact.title ?? fact.desktopSessionId}`;
    case 'side-session-note':
      return `Note from ${fact.title}: ${fact.report}`;
    default:
      return 'Unknown fact';
  }
};

export const workFactInstant = (fact: WorkFact): string => {
  switch (fact.kind) {
    case 'declared-turn':
      return fact.declaredAt;
    case 'wrap-up':
    case 'turn-report':
    case 'side-session-note':
      return fact.at;
    case 'pull-request':
      return fact.updatedAt ?? fact.provenance.observedAt;
    case 'jira-issue':
      return fact.newestCommentAt ?? fact.updatedAt ?? fact.provenance.observedAt;
    case 'proposal':
      return fact.createdAt ?? fact.provenance.observedAt;
    default:
      return fact.provenance.observedAt;
  }
};
