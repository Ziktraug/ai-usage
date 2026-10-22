import {
  CHECKOUT_STATUS_OUTCOMES,
  type CheckoutStatusOutcome,
  type ClaudeDesktopTurnStatus,
  describeCheckoutOutcome,
  describeCheckoutState,
  isCheckoutReadFailure,
  WORK_ATTENTION_KINDS,
  WORK_REQUEST_DORMANT_AFTER_MS,
  type WorkAttentionDataset,
  type WorkAttentionKind,
  type WorkFact,
  type WorkFactSource,
  type WorkInterpretation,
  type WorkInterpretationKind,
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
    // Earlier questions of the root: a question answered in the harness is still findable by its words.
    ...root.facts.flatMap((fact) =>
      fact.kind === 'declared-turn' && fact.desktopSessionId === root.desktopSessionId && fact.needsAction !== null
        ? [fact.needsAction]
        : [],
    ),
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

/** The age tier of ADR 0056, in days, for the words that name it. */
const DORMANT_DAYS = WORK_REQUEST_DORMANT_AFTER_MS / 86_400_000;

export const WORK_ATTENTION_SECTIONS: readonly WorkAttentionSection[] = [
  {
    collapseBeyond: null,
    kind: 'human-request',
    note: `Questions and review requests nothing recorded since has answered. Older declarations to reconsider follow: something later may have answered them, without proof, or nothing happened in their session for over ${DORMANT_DAYS} days.`,
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
  {
    // ADR 0059: a harness that declares no turn status. Unknown is not "nothing pending".
    collapseBeyond: 10,
    kind: 'not-observable',
    note: 'Codex records no turn status: these sessions show their checkout, branch and last activity only. Whether one waits on you is unknown — not declared by this harness, which is not the same as nothing pending.',
    title: 'Codex · no declared wait read',
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

/**
 * What a row says in place of a declaration it has none of: a Claude Desktop root that declared
 * nothing, a root of a harness that declares nothing at all (ADR 0059), or bare activity.
 */
export const workUndeclaredSituation = (root: WorkRoot): string => {
  if (root.attention === 'not-observable') {
    return `wait unknown · not declared by ${workHarnessLabel(root.key.harness)}`;
  }
  return root.key.harness === 'claude' ? 'no declaration' : 'activity only';
};

// ---------------------------------------------------------------------------------------------
// Standing of a root's request (ADR 0056): read from the interpretations, never recomputed here
// ---------------------------------------------------------------------------------------------

/**
 * Where a root's request stands. `current` is a confirmed block nothing later touches;
 * `reconsider` an older declaration something later may have answered without proof; `answered`,
 * `handled` and `archived` name a dated native record that it no longer waits; `none` asks nothing;
 * `not-declared` is a root of a harness that declares no turn status, whose standing is unknown.
 */
export type WorkRootStanding = 'answered' | 'archived' | 'current' | 'handled' | 'none' | 'not-declared' | 'reconsider';

const CLOSING_STANDINGS: Partial<Record<WorkInterpretationKind, WorkRootStanding>> = {
  'request-answered': 'answered',
  'request-archived': 'archived',
  'request-handled-elsewhere': 'handled',
};

export const workRootStanding = (root: WorkRoot): WorkRootStanding => {
  for (const entry of root.interpretations) {
    const standing = CLOSING_STANDINGS[entry.kind];
    if (standing !== undefined) {
      return standing;
    }
  }
  if (root.attention === 'human-request') {
    return root.reconsidered ? 'reconsider' : 'current';
  }
  return root.attention === 'not-observable' ? 'not-declared' : 'none';
};

export const WORK_STANDING_LABELS: Readonly<Record<WorkRootStanding, string>> = {
  answered: 'Answered in Claude Desktop',
  archived: 'Archived in Claude Desktop',
  current: 'Current block',
  handled: 'Handled in a linked session',
  none: 'Nothing asked',
  'not-declared': 'Unknown — not declared by this harness',
  reconsider: 'Older declaration to reconsider',
};

const factById = (root: WorkRoot, id: string | undefined): WorkFact | undefined =>
  id === undefined ? undefined : root.facts.find((fact) => fact.id === id);

const declaredAtOf = (fact: WorkFact | undefined): string | null =>
  fact?.kind === 'declared-turn' ? fact.declaredAt : null;

const quoted = (fact: WorkFact | undefined): string =>
  fact?.kind === 'declared-turn' && fact.needsAction !== null ? `“${fact.needsAction}”` : 'the review request';

/** A request nothing touched for more than the age tier of ADR 0056: set apart, never settled. */
const isDormant = (root: WorkRoot): boolean => root.interpretations.some(({ kind }) => kind === 'request-dormant');

/**
 * What a request set apart by its age says after its date in the row ("blocked · 9 d ago, no
 * activity since"); `null` for any other root. "No activity since" is claimed only for a root
 * without children whose last activity is its declaration: a family's later activity is not on
 * the row, so the note then claims only the week of silence the interpretation established.
 */
export const workRootDormantNote = (root: WorkRoot): string | null => {
  if (!isDormant(root)) {
    return null;
  }
  const declaredAt = root.declared?.at ?? null;
  const lastActivity = root.age.lastActivityAt;
  const quietSinceDeclared =
    root.children.count === 0 &&
    declaredAt !== null &&
    (lastActivity === null || Date.parse(lastActivity) <= Date.parse(declaredAt));
  return quietSinceDeclared ? 'no activity since' : `no activity in over ${DORMANT_DAYS} d`;
};

/** The latest decision recorded about the root's requests, for the row: what was settled, dated by a fact. */
export interface WorkRootDecision {
  readonly instant: string | null;
  readonly instantLabel: string;
  readonly kind: WorkInterpretationKind;
  readonly text: string;
}

const decisionOf = (root: WorkRoot, entry: WorkInterpretation): WorkRootDecision | null => {
  switch (entry.kind) {
    case 'request-answered':
      // The message's own time is in the detail; the row dates the question it answered.
      return {
        instant: root.declared?.at ?? null,
        instantLabel: 'asked',
        kind: entry.kind,
        text: 'You answered in Claude Desktop',
      };
    case 'request-handled-elsewhere':
      return {
        instant: declaredAtOf(factById(root, entry.evidence.at(-1))),
        instantLabel: 'completed',
        kind: entry.kind,
        text: 'Handled in a session started from it',
      };
    case 'request-archived':
      return {
        instant: root.age.lastObservedAt,
        instantLabel: 'observed',
        kind: entry.kind,
        text: 'Archived in Claude Desktop',
      };
    case 'earlier-request-answered': {
      const earlier = factById(root, entry.evidence[0]);
      return {
        instant: declaredAtOf(earlier),
        instantLabel: 'asked',
        kind: entry.kind,
        text: `Earlier ${quoted(earlier)} answered in Claude Desktop`,
      };
    }
    case 'earlier-request-superseded': {
      const earlier = factById(root, entry.evidence[0]);
      return {
        instant: declaredAtOf(earlier),
        instantLabel: 'asked',
        kind: entry.kind,
        text: `Earlier ${quoted(earlier)} replaced by a later declaration`,
      };
    }
    default:
      return null;
  }
};

const DECISION_ORDER: readonly WorkInterpretationKind[] = [
  'request-answered',
  'request-handled-elsewhere',
  'request-archived',
  'earlier-request-answered',
  'earlier-request-superseded',
];

export const workRootLastDecision = (root: WorkRoot): WorkRootDecision | null => {
  for (const kind of DECISION_ORDER) {
    const entry = root.interpretations.find((candidate) => candidate.kind === kind);
    if (entry !== undefined) {
      return decisionOf(root, entry);
    }
  }
  return null;
};

/** Open proposal facts an interpretation says are no longer pending (superseded or expired). */
export const workRootPastProposalIds = (root: WorkRoot): ReadonlySet<string> =>
  new Set(
    root.interpretations
      .filter(({ kind }) => kind === 'proposal-superseded' || kind === 'proposal-expired')
      .flatMap(({ evidence }) => evidence),
  );

/** What the person can do next, in one line; `null` when nothing is asked of them. */
export const workRootNextAction = (root: WorkRoot): string | null => {
  switch (workRootStanding(root)) {
    case 'current':
      if (root.declared?.status === 'review_ready') {
        return 'Review the change, then tell the session in Claude Desktop.';
      }
      return root.declared?.needsAction
        ? 'Answer in Claude Desktop.'
        : 'Read the new Jira reply, then resume the session.';
    case 'reconsider':
      return isDormant(root)
        ? `Nothing happened in it for over ${DORMANT_DAYS} days; answer or archive the session in Claude Desktop to settle it.`
        : 'Check what followed; answer or archive the session in Claude Desktop to settle it.';
    case 'answered':
      return 'Nothing asked of you since your message.';
    case 'handled':
      return 'Nothing asked of you; the linked session’s outcome is in the detail.';
    case 'not-declared':
      return `Check the session in ${workHarnessLabel(root.key.harness)}; this view cannot tell whether it waits on you.`;
    default:
      break;
  }
  if (root.attention === 'external-wait') {
    return 'Waiting on a pull request review on GitHub.';
  }
  if (root.attention === 'optional-lead') {
    return 'Optional: start or dismiss the proposal in Claude Desktop.';
  }
  return null;
};

/**
 * What the read took from Codex, for the coverage line (ADR 0059): sessions only, from the served
 * report, never a declared wait. Counts the Codex roots the dataset carries, so it says "shown"; a
 * family the page left out is counted by the search coverage beside it.
 */
export const workCodexCoverage = (dataset: Pick<WorkAttentionDataset, 'coverage' | 'roots'>): string => {
  const shown = dataset.roots.filter((root) => root.key.harness === 'codex').length;
  const { sinceDays } = dataset.coverage.window;
  // Codex rows have their own budget (ADR 0059) and the page limit cuts them first: say how many.
  const inWindow = Math.max(dataset.coverage.codexSessions.campaignsInWindow, shown);
  if (shown > 0) {
    return `${shown} of ${inWindow} Codex ${inWindow === 1 ? 'campaign' : 'campaigns'} shown, active in the last ${sinceDays} days (served report)`;
  }
  if (dataset.coverage.sessions.revision === null) {
    return 'not read: no served report revision yet';
  }
  if (inWindow > 0) {
    // Desktop roots rank first and filled the page: the campaigns exist; absence is never claimed.
    return `0 of ${inWindow} Codex ${inWindow === 1 ? 'campaign' : 'campaigns'} shown: the page limit left them out (active in the last ${sinceDays} days, served report)`;
  }
  return `no session active in the last ${sinceDays} days`;
};

/**
 * What a search or a filter covered, said plainly: the ranking is a selection of the read, so a
 * filter over it is never presented as a search of everything collected.
 */
export const workSearchCoverage = (
  dataset: Pick<WorkAttentionDataset, 'coverage' | 'roots' | 'totalRoots'>,
  matched: number,
  filtered: boolean,
): string => {
  const shown = dataset.roots.length;
  const windowed = dataset.coverage.window.excludedRoots;
  const beyondRanking = Math.max(dataset.totalRoots - shown - windowed, 0);
  const left: string[] = [];
  if (windowed > 0) {
    left.push(
      `${windowed} older ${windowed === 1 ? 'root' : 'roots'} without a pending declaration (${dataset.coverage.window.sinceDays}-day window)`,
    );
  }
  if (beyondRanking > 0) {
    left.push(`${beyondRanking} beyond the ranking limit`);
  }
  const { sessionsRead, sessionsStored, truncated } = dataset.coverage.desktopSessions;
  if (sessionsRead < sessionsStored) {
    const unread = sessionsStored - sessionsRead;
    left.push(`${unread} older ${unread === 1 ? 'session' : 'sessions'} without a wait (read bound)`);
  } else if (truncated) {
    left.push('sessions the registry listing left unread');
  }
  const head = filtered
    ? `${matched} of ${shown} roots match. Searched the ${shown} roots in this ranking`
    : `${matched} of ${shown} roots shown`;
  if (left.length === 0) {
    return `${head}${filtered ? '; nothing else was read.' : '.'}`;
  }
  return `${head}; not ${filtered ? 'searched' : 'shown'}: ${left.join(', ')}.`;
};

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

/** Why a checkout has no git status: a failed read says so, a removed or non-repository path is stated as such. */
const checkoutUnreadWords = (outcome: CheckoutStatusOutcome): string =>
  isCheckoutReadFailure(outcome) ? `not read (${describeCheckoutOutcome(outcome)})` : describeCheckoutOutcome(outcome);

/**
 * Why the checkouts of the shown roots have no git status, by kind and in plain words, for the
 * coverage line: the producer's run counts its failures without their kinds, the facts carry them.
 * Each checkout (machine and path) counts once, by its latest observation; `null` when every one
 * of them was read.
 */
export const workCheckoutUnreadSummary = (roots: readonly WorkRoot[]): string | null => {
  const latest = new Map<string, Extract<WorkFact, { kind: 'checkout-status' }>>();
  for (const fact of roots.flatMap((root) => root.facts)) {
    if (fact.kind !== 'checkout-status') {
      continue;
    }
    const key = JSON.stringify([fact.provenance.machineId, fact.checkoutPath]);
    const known = latest.get(key);
    if (known === undefined || Date.parse(known.provenance.observedAt) < Date.parse(fact.provenance.observedAt)) {
      latest.set(key, fact);
    }
  }
  const counts = new Map<CheckoutStatusOutcome, number>();
  for (const { outcome } of latest.values()) {
    if (outcome !== 'observed') {
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
  }
  const parts = CHECKOUT_STATUS_OUTCOMES.flatMap((outcome) => {
    const count = counts.get(outcome);
    return count === undefined ? [] : [`${count} ${checkoutUnreadWords(outcome)}`];
  });
  return parts.length === 0 ? null : `of the checkouts the roots shown name: ${parts.join(', ')}`;
};

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
    const continued = root.interpretations.some(({ kind }) => kind === 'request-continued-elsewhere');
    const satisfied = root.interpretations.some(({ kind }) => kind === 'request-satisfied-elsewhere');
    // A request set apart by its age alone was answered by nothing: its row says so by its date.
    if (number !== null || satisfied || !(continued || isDormant(root))) {
      chips.push({
        id: `${workRootId(root)}:reconsidered`,
        instant: null,
        instantLabel: null,
        label: number === null ? 'possibly answered' : `possibly answered · PR #${number}`,
        tone: 'neutral',
      });
    }
    if (continued) {
      chips.push({
        id: `${workRootId(root)}:continued`,
        instant: null,
        instantLabel: null,
        label: 'work continued in a linked session',
        tone: 'neutral',
      });
    }
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
    if (fact.kind !== 'checkout-status') {
      continue;
    }
    if (fact.outcome !== 'observed') {
      chips.push({
        id: fact.id,
        instant: fact.provenance.observedAt,
        instantLabel: 'observed',
        label: `checkout ${checkoutUnreadWords(fact.outcome)}`,
        // Gone since the session, or never a repository: a fact about the session, not an alarm.
        tone: isCheckoutReadFailure(fact.outcome) ? 'warn' : 'neutral',
      });
    } else if (fact.dirty === true || (fact.ahead ?? 0) > 0) {
      // A clean checkout level with its upstream says nothing to resume; commits not pushed do.
      chips.push({
        id: fact.id,
        instant: fact.provenance.observedAt,
        instantLabel: 'observed',
        label: `checkout ${describeCheckoutState(fact)}`,
        tone: fact.dirty === true ? 'warn' : 'neutral',
      });
    }
  }
  const proposals = root.facts.filter(
    (fact): fact is Extract<WorkFact, { kind: 'proposal' }> => fact.kind === 'proposal',
  );
  if (proposals.length > 0) {
    const open = proposals.filter((fact) => fact.resolution === 'open').length;
    const past = workRootPastProposalIds(root).size;
    chips.push({
      id: `${workRootId(root)}:proposals`,
      instant: null,
      instantLabel: null,
      label: `proposals ${open - past} open / ${proposals.length - open} resolved${past > 0 ? ` / ${past} no longer pending` : ''}`,
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
export const workFactSummary = (fact: WorkFact, root?: WorkRoot): string => {
  switch (fact.kind) {
    case 'declared-turn':
      if (root !== undefined && fact.desktopSessionId !== root.desktopSessionId) {
        return `Linked session declared ${workDeclaredStatusLabel(fact.status)}: ${fact.needsAction ?? fact.detail}`;
      }
      if (root !== undefined && fact.declaredAt !== root.declared?.at) {
        return `Earlier declaration, ${workDeclaredStatusLabel(fact.status)}: ${fact.needsAction ?? fact.detail}`;
      }
      return `Declared ${workDeclaredStatusLabel(fact.status)}: ${fact.detail}`;
    case 'declared-pull-request':
      return `Declared PR #${fact.number} ${fact.state.toLowerCase()} on ${fact.repository}${fact.branch ? ` (${fact.branch})` : ''}`;
    case 'pull-request':
      return fact.outcome === 'observed' && fact.state
        ? `PR #${fact.number} ${fact.state.toLowerCase()}${fact.draft ? ', draft' : ''}${fact.checksRollup ? `, checks ${fact.checksRollup}` : ''}${fact.reviewDecision ? `, ${fact.reviewDecision.toLowerCase().replaceAll('_', ' ')}` : ''}`
        : `PR #${fact.number} read failed: ${fact.outcome}`;
    case 'checkout-status':
      return fact.outcome === 'observed'
        ? `Checkout ${fact.checkoutPath}${fact.branch ? ` on ${fact.branch}` : ''}: ${describeCheckoutState(fact)}`
        : `Checkout ${fact.checkoutPath}: ${isCheckoutReadFailure(fact.outcome) ? `not read, ${describeCheckoutOutcome(fact.outcome)}` : describeCheckoutOutcome(fact.outcome)}`;
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
