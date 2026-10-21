import type { CanonicalInstant } from './canonical-instant';
import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';

/**
 * Work attention: the shared contract between the collectors that observe what a Session
 * declares about itself (Claude Desktop metadata), the producers that observe external and
 * local facts (GitHub pull requests, checkout status), the read model that confronts them,
 * and the Work view that renders the result.
 *
 * Three vocabularies stay apart on purpose (CONTEXT.md, plan 117, campaign contracts):
 *
 * - A **declaration** is what a Session said at its last turn end (`status`, `needsAction`),
 *   dated by the Session itself. It is never presented as the current state.
 * - A **fact** is one dated observation of one source with its coverage. Facts are stored and
 *   re-validated on read; they never carry a verdict.
 * - An **interpretation** confronts declarations and facts and names its own uncertainty. It is
 *   computed by the read model and never persisted.
 *
 * The bounds below are read-cost ceilings. Raising one is safe; lowering one retroactively hides
 * rows already on disk, so collectors clamp before persisting and readers reject above the bound.
 */
export const WORK_ATTENTION_BOUNDS = {
  maxChildrenTitles: 5,
  maxDetailText: 512,
  maxFacts: 64,
  maxId: 512,
  maxInterpretations: 16,
  maxJiraAuthorLabel: 64,
  maxJiraCommentExcerpt: 280,
  maxJiraComments: 10,
  maxListItems: 64,
  maxPath: 4096,
  maxReportText: 1000,
  maxRoots: 200,
  maxShortText: 256,
  maxSideSessionNotes: 20,
} as const;

export interface WorkSessionKey {
  readonly harness: string;
  readonly machineId: string;
  readonly sourceSessionId: string;
}

export const workSessionKeyString = (key: WorkSessionKey): string =>
  JSON.stringify([key.machineId, key.harness, key.sourceSessionId]);

// ---------------------------------------------------------------------------------------------
// Fact family 1 — Claude Desktop session metadata (one row per desktop session)
// ---------------------------------------------------------------------------------------------

export const CLAUDE_DESKTOP_TURN_STATUSES = ['blocked', 'completed', 'review_ready'] as const;
export type ClaudeDesktopTurnStatus = (typeof CLAUDE_DESKTOP_TURN_STATUSES)[number];
export const CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS = ['started_notified', 'dismissed'] as const;
export type ClaudeDesktopSuggestionResolution = (typeof CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS)[number];
export const CLAUDE_DESKTOP_SESSION_FORMATS = ['claude-desktop-session-v1', 'unsupported'] as const;
export type ClaudeDesktopSessionFormat = (typeof CLAUDE_DESKTOP_SESSION_FORMATS)[number];
export const CLAUDE_DESKTOP_TITLE_SOURCES = ['auto', 'tool', 'unknown'] as const;
export type ClaudeDesktopTitleSource = (typeof CLAUDE_DESKTOP_TITLE_SOURCES)[number];

/** `postTurnSummary`: the Session's own last-turn declaration. `needsAction` is the question asked. */
export interface ClaudeDesktopTurnSummary {
  readonly detail: string;
  readonly needsAction: string | null;
  readonly status: ClaudeDesktopTurnStatus;
  readonly summarizesUuid: string | null;
}

/** `spawnedFrom`: the desktop session that started this one. Attested, never inferred. */
export interface ClaudeDesktopSpawnOrigin {
  readonly sessionId: string;
  readonly sideSession: boolean | null;
  readonly taskId: string | null;
  readonly title: string | null;
}

/** `backgroundTaskSuggestions[]` without its `prompt`: a proposal is never persisted with its brief. */
export interface ClaudeDesktopSuggestion {
  readonly createdAt: CanonicalInstant | null;
  readonly expiresAt: CanonicalInstant | null;
  readonly id: string;
  readonly title: string;
  readonly tldr: string | null;
}

/** `prs[]` as declared by the desktop app at the file's modification time; may mirror the checkout branch. */
export interface ClaudeDesktopDeclaredPullRequest {
  readonly baseRef: string | null;
  readonly branch: string | null;
  readonly host: string;
  readonly number: number;
  readonly own: boolean | null;
  readonly repository: string;
  readonly state: string;
  readonly url: string | null;
}

/** `sideSessionNotes[]`: short reports a child session sent to this root. */
export interface ClaudeDesktopSideSessionNote {
  readonly at: CanonicalInstant;
  readonly report: string;
  readonly sessionId: string;
  readonly title: string;
}

export interface ClaudeDesktopSessionObservation {
  readonly accountDirectory: string;
  readonly archived: boolean;
  readonly branch: string | null;
  /** The Claude Code transcript id; the join key to the collected Session (`sourceSessionId`). */
  readonly cliSessionId: string;
  readonly completedTurns: number | null;
  readonly createdAt: CanonicalInstant;
  readonly cwd: string;
  readonly declaredPullRequests: readonly ClaudeDesktopDeclaredPullRequest[];
  readonly desktopSessionId: string;
  readonly effort: string | null;
  readonly fileModifiedAt: CanonicalInstant;
  /** Path relative to the observed home; never an absolute path into another user's profile. */
  readonly filePath: string;
  readonly format: ClaudeDesktopSessionFormat;
  readonly lastActivityAt: CanonicalInstant;
  readonly lastTurnReport: string | null;
  readonly machineId: string;
  readonly model: string | null;
  /** Collection time; distinct from `fileModifiedAt` and from `lastActivityAt`. */
  readonly observedAt: CanonicalInstant;
  readonly openSuggestions: readonly ClaudeDesktopSuggestion[];
  readonly organizationDirectory: string;
  readonly originCwd: string | null;
  readonly priorCliSessionIds: readonly string[];
  readonly resolvedSuggestions: Readonly<Record<string, ClaudeDesktopSuggestionResolution>>;
  readonly sideSessionNotes: readonly ClaudeDesktopSideSessionNote[];
  readonly sourceBranch: string | null;
  readonly spawnedFrom: ClaudeDesktopSpawnOrigin | null;
  readonly title: string;
  readonly titleSource: ClaudeDesktopTitleSource;
  readonly turnSummary: ClaudeDesktopTurnSummary | null;
  readonly unsupportedReason: string | null;
  readonly worktreePath: string | null;
  readonly wrapUpDescription: string | null;
  readonly writtenBranches: readonly string[];
}

/**
 * What one sweep of the Desktop registry saw. Persisted beside the rows so a read can say how
 * complete they are: `truncated` means files were left unread (bound reached, directory unreadable),
 * `unsupported` counts files kept as identity-only rows, `rejected` counts files that yielded none.
 */
export interface ClaudeDesktopCollectionCompleteness {
  readonly filesParsed: number;
  readonly filesSeen: number;
  readonly rejected: number;
  readonly truncated: boolean;
  readonly unsupported: number;
}

const text = (value: unknown, maxLength: number): string | null =>
  typeof value === 'string' && value.length <= maxLength ? value : null;
const requiredText = (value: unknown, maxLength: number): string | null => {
  const parsed = text(value, maxLength);
  return parsed === null || parsed.trim().length === 0 ? null : parsed;
};
const optionalText = (value: unknown, maxLength: number): string | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = text(value, maxLength);
  return parsed === null ? undefined : parsed;
};
const optionalBoolean = (value: unknown): boolean | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'boolean' ? value : undefined;
};
const optionalCount = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
const optionalInstant = (value: unknown): CanonicalInstant | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = normalizeIsoTimestamp(value);
  return parsed ?? undefined;
};
const oneOf = <const Values extends readonly string[]>(values: Values, value: unknown): Values[number] | undefined =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as Values[number]) : undefined;
const textList = (value: unknown, maxLength: number, maxItems: number): readonly string[] | undefined => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    return;
  }
  const items: string[] = [];
  for (const entry of value) {
    const parsed = requiredText(entry, maxLength);
    if (parsed === null) {
      return;
    }
    items.push(parsed);
  }
  return items;
};
const list = <Item>(
  value: unknown,
  maxItems: number,
  parseItem: (entry: unknown) => Item | null,
): readonly Item[] | undefined => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    return;
  }
  const items: Item[] = [];
  for (const entry of value) {
    const parsed = parseItem(entry);
    if (parsed === null) {
      return;
    }
    items.push(parsed);
  }
  return items;
};

const {
  maxDetailText,
  maxId,
  maxJiraAuthorLabel,
  maxJiraCommentExcerpt,
  maxJiraComments,
  maxListItems,
  maxPath,
  maxReportText,
  maxShortText,
  maxSideSessionNotes,
} = WORK_ATTENTION_BOUNDS;

const parseTurnSummary = (value: unknown): ClaudeDesktopTurnSummary | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return;
  }
  const status = oneOf(CLAUDE_DESKTOP_TURN_STATUSES, value.status);
  const detail = text(value.detail, maxDetailText);
  const needsAction = optionalText(value.needsAction, maxDetailText);
  const summarizesUuid = optionalText(value.summarizesUuid, maxId);
  if (status === undefined || detail === null || needsAction === undefined || summarizesUuid === undefined) {
    return;
  }
  return { detail, needsAction, status, summarizesUuid };
};

const parseSpawnOrigin = (value: unknown): ClaudeDesktopSpawnOrigin | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return;
  }
  const sessionId = requiredText(value.sessionId, maxId);
  const taskId = optionalText(value.taskId, maxId);
  const title = optionalText(value.title, maxShortText);
  const sideSession = optionalBoolean(value.sideSession);
  if (sessionId === null || taskId === undefined || title === undefined || sideSession === undefined) {
    return;
  }
  return { sessionId, sideSession, taskId, title };
};

const parseSuggestion = (value: unknown): ClaudeDesktopSuggestion | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = requiredText(value.id, maxId);
  const title = requiredText(value.title, maxShortText);
  const tldr = optionalText(value.tldr, maxDetailText);
  const createdAt = optionalInstant(value.createdAt);
  const expiresAt = optionalInstant(value.expiresAt);
  if (id === null || title === null || tldr === undefined || createdAt === undefined || expiresAt === undefined) {
    return null;
  }
  return { createdAt, expiresAt, id, title, tldr };
};

const parseDeclaredPullRequest = (value: unknown): ClaudeDesktopDeclaredPullRequest | null => {
  if (!isRecord(value)) {
    return null;
  }
  const host = requiredText(value.host, maxShortText);
  const repository = requiredText(value.repository, maxShortText);
  const state = requiredText(value.state, maxShortText);
  const branch = optionalText(value.branch, maxShortText);
  const baseRef = optionalText(value.baseRef, maxShortText);
  const url = optionalText(value.url, maxPath);
  const own = optionalBoolean(value.own);
  const number = value.number;
  if (
    host === null ||
    repository === null ||
    state === null ||
    branch === undefined ||
    baseRef === undefined ||
    url === undefined ||
    own === undefined ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    return null;
  }
  return { baseRef, branch, host, number, own, repository, state, url };
};

const parseSideSessionNote = (value: unknown): ClaudeDesktopSideSessionNote | null => {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = requiredText(value.sessionId, maxId);
  const title = text(value.title, maxShortText);
  const report = text(value.report, maxReportText);
  const at = normalizeIsoTimestamp(value.at);
  if (sessionId === null || title === null || report === null || at === null) {
    return null;
  }
  return { at, report, sessionId, title };
};

const parseResolvedSuggestions = (
  value: unknown,
): Readonly<Record<string, ClaudeDesktopSuggestionResolution>> | undefined => {
  if (value === null || value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > maxListItems) {
    return;
  }
  const resolved: Record<string, ClaudeDesktopSuggestionResolution> = {};
  for (const [id, resolution] of entries) {
    const parsed = oneOf(CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS, resolution);
    if (id.length === 0 || id.length > maxId || parsed === undefined) {
      return;
    }
    resolved[id] = parsed;
  }
  return resolved;
};

/**
 * Validates one normalized Claude Desktop session observation, on the way into the store and
 * again on the way out. Returns `null` for anything that is not a complete, in-bounds row; the
 * caller counts it as skipped rather than discarding it silently. Parsing the native
 * `local_*.json` file into this shape is the collector's job (`packages/local-collectors`).
 */
export const parseClaudeDesktopSessionObservation = (value: unknown): ClaudeDesktopSessionObservation | null => {
  if (!isRecord(value)) {
    return null;
  }
  const machineId = requiredText(value.machineId, maxId);
  const desktopSessionId = requiredText(value.desktopSessionId, maxId);
  const accountDirectory = requiredText(value.accountDirectory, maxId);
  const organizationDirectory = requiredText(value.organizationDirectory, maxId);
  const cliSessionId = requiredText(value.cliSessionId, maxId);
  const priorCliSessionIds = textList(value.priorCliSessionIds, maxId, maxListItems);
  const filePath = requiredText(value.filePath, maxPath);
  const fileModifiedAt = normalizeIsoTimestamp(value.fileModifiedAt);
  const observedAt = normalizeIsoTimestamp(value.observedAt);
  const format = oneOf(CLAUDE_DESKTOP_SESSION_FORMATS, value.format);
  const unsupportedReason = optionalText(value.unsupportedReason, maxDetailText);
  const title = text(value.title, maxShortText);
  const titleSource = oneOf(CLAUDE_DESKTOP_TITLE_SOURCES, value.titleSource);
  const createdAt = normalizeIsoTimestamp(value.createdAt);
  const lastActivityAt = normalizeIsoTimestamp(value.lastActivityAt);
  const archived = typeof value.archived === 'boolean' ? value.archived : undefined;
  const completedTurns = optionalCount(value.completedTurns);
  const model = optionalText(value.model, maxShortText);
  const effort = optionalText(value.effort, maxShortText);
  const cwd = requiredText(value.cwd, maxPath);
  const originCwd = optionalText(value.originCwd, maxPath);
  const worktreePath = optionalText(value.worktreePath, maxPath);
  const branch = optionalText(value.branch, maxShortText);
  const sourceBranch = optionalText(value.sourceBranch, maxShortText);
  const writtenBranches = textList(value.writtenBranches, maxShortText, maxListItems);
  const turnSummary = parseTurnSummary(value.turnSummary);
  const wrapUpDescription = optionalText(value.wrapUpDescription, maxReportText);
  const lastTurnReport = optionalText(value.lastTurnReport, maxReportText);
  const spawnedFrom = parseSpawnOrigin(value.spawnedFrom);
  const openSuggestions = list(value.openSuggestions, maxListItems, parseSuggestion);
  const resolvedSuggestions = parseResolvedSuggestions(value.resolvedSuggestions);
  const declaredPullRequests = list(value.declaredPullRequests, maxListItems, parseDeclaredPullRequest);
  const sideSessionNotes = list(value.sideSessionNotes, maxSideSessionNotes, parseSideSessionNote);
  if (
    machineId === null ||
    desktopSessionId === null ||
    accountDirectory === null ||
    organizationDirectory === null ||
    cliSessionId === null ||
    priorCliSessionIds === undefined ||
    filePath === null ||
    fileModifiedAt === null ||
    observedAt === null ||
    format === undefined ||
    unsupportedReason === undefined ||
    title === null ||
    titleSource === undefined ||
    createdAt === null ||
    lastActivityAt === null ||
    archived === undefined ||
    completedTurns === undefined ||
    model === undefined ||
    effort === undefined ||
    cwd === null ||
    originCwd === undefined ||
    worktreePath === undefined ||
    branch === undefined ||
    sourceBranch === undefined ||
    writtenBranches === undefined ||
    turnSummary === undefined ||
    wrapUpDescription === undefined ||
    lastTurnReport === undefined ||
    spawnedFrom === undefined ||
    openSuggestions === undefined ||
    resolvedSuggestions === undefined ||
    declaredPullRequests === undefined ||
    sideSessionNotes === undefined
  ) {
    return null;
  }
  return {
    accountDirectory,
    archived,
    branch,
    cliSessionId,
    completedTurns,
    createdAt,
    cwd,
    declaredPullRequests,
    desktopSessionId,
    effort,
    fileModifiedAt,
    filePath,
    format,
    lastActivityAt,
    lastTurnReport,
    machineId,
    model,
    observedAt,
    openSuggestions,
    organizationDirectory,
    originCwd,
    priorCliSessionIds,
    resolvedSuggestions,
    sideSessionNotes,
    sourceBranch,
    spawnedFrom,
    title,
    titleSource,
    turnSummary,
    unsupportedReason,
    worktreePath,
    wrapUpDescription,
    writtenBranches,
  };
};

// ---------------------------------------------------------------------------------------------
// Fact family 2 — external and local facts
// ---------------------------------------------------------------------------------------------

export const PULL_REQUEST_OBSERVATION_OUTCOMES = [
  'observed',
  'unauthenticated',
  'not-found',
  'network',
  'timeout',
  'disabled',
  'invalid',
] as const;
export type PullRequestObservationOutcome = (typeof PULL_REQUEST_OBSERVATION_OUTCOMES)[number];
export const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
export const PULL_REQUEST_CHECK_ROLLUPS = ['success', 'failure', 'pending', 'unknown'] as const;
export type PullRequestCheckRollup = (typeof PULL_REQUEST_CHECK_ROLLUPS)[number];

/**
 * One dated read of one pull request through the GitHub CLI. A failed read is still an
 * observation: it keeps its outcome and leaves every GitHub-reported field null, so the last
 * successful observation remains the latest *fact* and the failure remains visible.
 */
export interface PullRequestObservation {
  readonly accountLabel: string | null;
  readonly baseRef: string | null;
  readonly checksRollup: PullRequestCheckRollup | null;
  readonly draft: boolean | null;
  readonly headRef: string | null;
  readonly host: string;
  readonly machineId: string;
  readonly mergedAt: CanonicalInstant | null;
  readonly number: number;
  readonly observedAt: CanonicalInstant;
  readonly outcome: PullRequestObservationOutcome;
  readonly outcomeMessage: string | null;
  readonly repository: string;
  readonly reviewDecision: string | null;
  readonly state: PullRequestState | null;
  readonly title: string | null;
  readonly updatedAt: CanonicalInstant | null;
  readonly url: string | null;
}

export const parsePullRequestObservation = (value: unknown): PullRequestObservation | null => {
  if (!isRecord(value)) {
    return null;
  }
  const machineId = requiredText(value.machineId, maxId);
  const host = requiredText(value.host, maxShortText);
  const repository = requiredText(value.repository, maxShortText);
  const number = value.number;
  const observedAt = normalizeIsoTimestamp(value.observedAt);
  const outcome = oneOf(PULL_REQUEST_OBSERVATION_OUTCOMES, value.outcome);
  const outcomeMessage = optionalText(value.outcomeMessage, maxDetailText);
  const accountLabel = optionalText(value.accountLabel, maxShortText);
  const state = value.state === null || value.state === undefined ? null : oneOf(PULL_REQUEST_STATES, value.state);
  const draft = optionalBoolean(value.draft);
  const reviewDecision = optionalText(value.reviewDecision, maxShortText);
  const mergedAt = optionalInstant(value.mergedAt);
  const updatedAt = optionalInstant(value.updatedAt);
  const title = optionalText(value.title, maxShortText);
  const url = optionalText(value.url, maxPath);
  const headRef = optionalText(value.headRef, maxShortText);
  const baseRef = optionalText(value.baseRef, maxShortText);
  const checksRollup =
    value.checksRollup === null || value.checksRollup === undefined
      ? null
      : oneOf(PULL_REQUEST_CHECK_ROLLUPS, value.checksRollup);
  if (
    machineId === null ||
    host === null ||
    repository === null ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    observedAt === null ||
    outcome === undefined ||
    outcomeMessage === undefined ||
    accountLabel === undefined ||
    state === undefined ||
    draft === undefined ||
    reviewDecision === undefined ||
    mergedAt === undefined ||
    updatedAt === undefined ||
    title === undefined ||
    url === undefined ||
    headRef === undefined ||
    baseRef === undefined ||
    checksRollup === undefined
  ) {
    return null;
  }
  return {
    accountLabel,
    baseRef,
    checksRollup,
    draft,
    headRef,
    host,
    machineId,
    mergedAt,
    number,
    observedAt,
    outcome,
    outcomeMessage,
    repository,
    reviewDecision,
    state,
    title,
    updatedAt,
    url,
  };
};

export const CHECKOUT_STATUS_OUTCOMES = [
  'observed',
  'missing',
  'not-a-repository',
  'timeout',
  'denied',
  'invalid',
] as const;
export type CheckoutStatusOutcome = (typeof CHECKOUT_STATUS_OUTCOMES)[number];

/**
 * One dated, read-only look at a checkout (`git status --porcelain=v2 --branch`). The first dirty
 * observation does not date the changes: `dirty` says what was seen at `observedAt`, nothing more.
 */
export interface CheckoutStatusObservation {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly branch: string | null;
  readonly checkoutPath: string;
  readonly dirty: boolean | null;
  readonly headSha: string | null;
  readonly lastCommitAt: CanonicalInstant | null;
  readonly machineId: string;
  readonly modifiedCount: number | null;
  readonly observedAt: CanonicalInstant;
  readonly outcome: CheckoutStatusOutcome;
  readonly stagedCount: number | null;
  readonly untrackedCount: number | null;
  readonly upstream: string | null;
}

export const parseCheckoutStatusObservation = (value: unknown): CheckoutStatusObservation | null => {
  if (!isRecord(value)) {
    return null;
  }
  const machineId = requiredText(value.machineId, maxId);
  const checkoutPath = requiredText(value.checkoutPath, maxPath);
  const observedAt = normalizeIsoTimestamp(value.observedAt);
  const outcome = oneOf(CHECKOUT_STATUS_OUTCOMES, value.outcome);
  const branch = optionalText(value.branch, maxShortText);
  const headSha = optionalText(value.headSha, maxShortText);
  const upstream = optionalText(value.upstream, maxShortText);
  const ahead = optionalCount(value.ahead);
  const behind = optionalCount(value.behind);
  const stagedCount = optionalCount(value.stagedCount);
  const modifiedCount = optionalCount(value.modifiedCount);
  const untrackedCount = optionalCount(value.untrackedCount);
  const lastCommitAt = optionalInstant(value.lastCommitAt);
  const dirty = optionalBoolean(value.dirty);
  if (
    machineId === null ||
    checkoutPath === null ||
    observedAt === null ||
    outcome === undefined ||
    branch === undefined ||
    headSha === undefined ||
    upstream === undefined ||
    ahead === undefined ||
    behind === undefined ||
    stagedCount === undefined ||
    modifiedCount === undefined ||
    untrackedCount === undefined ||
    lastCommitAt === undefined ||
    dirty === undefined
  ) {
    return null;
  }
  return {
    ahead,
    behind,
    branch,
    checkoutPath,
    dirty,
    headSha,
    lastCommitAt,
    machineId,
    modifiedCount,
    observedAt,
    outcome,
    stagedCount,
    untrackedCount,
    upstream,
  };
};

// ---------------------------------------------------------------------------------------------
// Fact family 3 — Jira issues a session explicitly linked, read through the operator's `acli`
// ---------------------------------------------------------------------------------------------

export const JIRA_ISSUE_OBSERVATION_OUTCOMES = [
  'observed',
  'unauthenticated',
  'not-found',
  'network',
  'timeout',
  'disabled',
  'invalid',
] as const;
export type JiraIssueObservationOutcome = (typeof JIRA_ISSUE_OBSERVATION_OUTCOMES)[number];
export const JIRA_STATUS_CATEGORIES = ['todo', 'in-progress', 'done', 'unknown'] as const;
export type JiraStatusCategory = (typeof JIRA_STATUS_CATEGORIES)[number];

/** An issue key as Jira writes it: an upper-case project key, a dash, a number. */
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

/** One comment as kept on this machine: who (a display label, never an address), when, a short excerpt. */
export interface JiraIssueComment {
  readonly authorLabel: string;
  readonly createdAt: CanonicalInstant;
  readonly excerpt: string;
  readonly id: string;
}

/**
 * One dated read of one Jira issue through the Atlassian CLI (ADR 0054). As for pull requests, a
 * failed read is an observation with its outcome and every Jira-reported field null, so the last
 * successful observation stays the latest fact and the failure stays visible beside it.
 * `comments` holds the newest `maxJiraComments` at most, newest first.
 */
export interface JiraIssueObservation {
  readonly assigneeLabel: string | null;
  readonly commentCount: number | null;
  readonly comments: readonly JiraIssueComment[];
  readonly key: string;
  readonly machineId: string;
  readonly observedAt: CanonicalInstant;
  readonly outcome: JiraIssueObservationOutcome;
  readonly outcomeMessage: string | null;
  readonly parentKey: string | null;
  readonly sprint: string | null;
  readonly status: string | null;
  readonly statusCategory: JiraStatusCategory | null;
  readonly summary: string | null;
  readonly updatedAt: CanonicalInstant | null;
}

const jiraKey = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= maxShortText && JIRA_ISSUE_KEY_PATTERN.test(value) ? value : null;

/** A person label the store may keep: non-empty, bounded, and never an e-mail address. */
const personLabel = (value: unknown): string | null | undefined => {
  const parsed = optionalText(value, maxJiraAuthorLabel);
  if (parsed === null || parsed === undefined) {
    return parsed;
  }
  return parsed.trim().length === 0 || parsed.includes('@') ? undefined : parsed;
};

const parseJiraIssueComment = (value: unknown): JiraIssueComment | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = requiredText(value.id, maxId);
  const authorLabel = personLabel(value.authorLabel);
  const createdAt = normalizeIsoTimestamp(value.createdAt);
  const excerpt = text(value.excerpt, maxJiraCommentExcerpt);
  if (id === null || authorLabel === null || authorLabel === undefined || createdAt === null || excerpt === null) {
    return null;
  }
  return { authorLabel, createdAt, excerpt, id };
};

export const parseJiraIssueObservation = (value: unknown): JiraIssueObservation | null => {
  if (!isRecord(value)) {
    return null;
  }
  const machineId = requiredText(value.machineId, maxId);
  const key = jiraKey(value.key);
  const observedAt = normalizeIsoTimestamp(value.observedAt);
  const outcome = oneOf(JIRA_ISSUE_OBSERVATION_OUTCOMES, value.outcome);
  const outcomeMessage = optionalText(value.outcomeMessage, maxDetailText);
  const status = optionalText(value.status, maxShortText);
  const statusCategory =
    value.statusCategory === null || value.statusCategory === undefined
      ? null
      : oneOf(JIRA_STATUS_CATEGORIES, value.statusCategory);
  const summary = optionalText(value.summary, maxShortText);
  const updatedAt = optionalInstant(value.updatedAt);
  const assigneeLabel = personLabel(value.assigneeLabel);
  const sprint = optionalText(value.sprint, maxShortText);
  const parentKey =
    value.parentKey === null || value.parentKey === undefined ? null : (jiraKey(value.parentKey) ?? undefined);
  const commentCount = optionalCount(value.commentCount);
  const comments = list(value.comments, maxJiraComments, parseJiraIssueComment);
  if (
    machineId === null ||
    key === null ||
    observedAt === null ||
    outcome === undefined ||
    outcomeMessage === undefined ||
    status === undefined ||
    statusCategory === undefined ||
    summary === undefined ||
    updatedAt === undefined ||
    assigneeLabel === undefined ||
    sprint === undefined ||
    parentKey === undefined ||
    commentCount === undefined ||
    comments === undefined
  ) {
    return null;
  }
  return {
    assigneeLabel,
    commentCount,
    comments,
    key,
    machineId,
    observedAt,
    outcome,
    outcomeMessage,
    parentKey,
    sprint,
    status,
    statusCategory,
    summary,
    updatedAt,
  };
};

// ---------------------------------------------------------------------------------------------
// Read model — what the Work view receives (assembled in `packages/report-data`)
// ---------------------------------------------------------------------------------------------

/**
 * First-level grouping of a root. `human-request` is a declared question or review request that
 * no later fact satisfies; `external-wait` is an open pull request waiting on someone else;
 * `optional-lead` is an unanswered proposal, never urgent; `none` is everything else.
 */
export const WORK_ATTENTION_KINDS = ['human-request', 'external-wait', 'optional-lead', 'none'] as const;
export type WorkAttentionKind = (typeof WORK_ATTENTION_KINDS)[number];

export const WORK_FACT_SOURCES = ['claude-desktop', 'claude-transcript', 'github', 'local-checkout', 'jira'] as const;
export type WorkFactSource = (typeof WORK_FACT_SOURCES)[number];

export interface WorkFactProvenance {
  readonly coverage: 'complete' | 'partial';
  readonly machineId: string;
  readonly observedAt: CanonicalInstant;
  readonly source: WorkFactSource;
}

interface WorkFactBase {
  readonly id: string;
  readonly provenance: WorkFactProvenance;
}

export type WorkFact = WorkFactBase &
  (
    | {
        readonly kind: 'declared-turn';
        readonly declaredAt: CanonicalInstant;
        readonly desktopSessionId: string;
        readonly detail: string;
        readonly needsAction: string | null;
        readonly status: ClaudeDesktopTurnStatus;
      }
    | {
        readonly kind: 'declared-pull-request';
        readonly branch: string | null;
        readonly host: string;
        readonly number: number;
        readonly repository: string;
        readonly state: string;
        readonly url: string | null;
      }
    | {
        readonly kind: 'pull-request';
        readonly accountLabel: string | null;
        readonly checksRollup: PullRequestCheckRollup | null;
        readonly draft: boolean | null;
        readonly host: string;
        readonly number: number;
        readonly outcome: PullRequestObservationOutcome;
        readonly repository: string;
        readonly reviewDecision: string | null;
        readonly state: PullRequestState | null;
        readonly updatedAt: CanonicalInstant | null;
        readonly url: string | null;
      }
    | {
        readonly kind: 'checkout-status';
        readonly ahead: number | null;
        readonly behind: number | null;
        readonly branch: string | null;
        readonly checkoutPath: string;
        readonly dirty: boolean | null;
        readonly lastCommitAt: CanonicalInstant | null;
        readonly modifiedCount: number | null;
        readonly outcome: CheckoutStatusOutcome;
        readonly untrackedCount: number | null;
      }
    | {
        readonly kind: 'jira-issue';
        readonly commentCount: number | null;
        readonly key: string;
        /** Comments created after the family's last activity; `null` when the read failed. */
        readonly newCommentsSince: number | null;
        readonly newestCommentAt: CanonicalInstant | null;
        readonly outcome: JiraIssueObservationOutcome;
        readonly status: string | null;
        readonly statusCategory: JiraStatusCategory | null;
        readonly updatedAt: CanonicalInstant | null;
        /** No browse address is built in this version: the Jira site is not part of the observation. */
        readonly url: null;
      }
    | {
        readonly kind: 'proposal';
        readonly createdAt: CanonicalInstant | null;
        readonly resolution: 'open' | ClaudeDesktopSuggestionResolution;
        readonly suggestionId: string;
        readonly title: string;
        readonly tldr: string | null;
      }
    | { readonly kind: 'wrap-up'; readonly at: CanonicalInstant; readonly text: string }
    | { readonly kind: 'turn-report'; readonly at: CanonicalInstant; readonly text: string }
    | { readonly kind: 'written-branch'; readonly branch: string }
    | {
        readonly kind: 'spawned-from';
        readonly desktopSessionId: string;
        readonly taskId: string | null;
        readonly title: string | null;
      }
    | {
        readonly kind: 'side-session-note';
        readonly at: CanonicalInstant;
        readonly report: string;
        readonly sessionId: string;
        readonly title: string;
      }
  );

export type WorkFactKind = WorkFact['kind'];

export const WORK_INTERPRETATION_KINDS = [
  'request-open',
  'request-satisfied-elsewhere',
  'review-ready',
  'external-review-pending',
  'pull-request-merged',
  'local-changes-unvalidated',
  'jira-reply-arrived',
  'jira-status-differs',
  'proposal-open',
  'proposal-resolved',
  'declared-status-stale',
  'coverage-gap',
] as const;
export type WorkInterpretationKind = (typeof WORK_INTERPRETATION_KINDS)[number];

/** A confrontation of declarations and facts. `evidence` lists the fact ids it rests on. */
export interface WorkInterpretation {
  readonly evidence: readonly string[];
  readonly kind: WorkInterpretationKind;
  readonly text: string;
  readonly uncertainty: string;
}

export interface WorkRootProject {
  readonly branch: string | null;
  readonly checkoutPath: string | null;
  readonly label: string;
  readonly worktreeName: string | null;
}

/** Children are counted and summarized under their root; they never become roots themselves. */
export interface WorkRootChildren {
  readonly blocked: number;
  readonly completed: number;
  readonly count: number;
  readonly reviewReady: number;
  readonly titles: readonly string[];
}

export interface WorkRootAge {
  readonly createdAt: CanonicalInstant | null;
  readonly declaredAt: CanonicalInstant | null;
  readonly lastActivityAt: CanonicalInstant | null;
  readonly lastObservedAt: CanonicalInstant | null;
}

export interface WorkRootDeclaration {
  readonly at: CanonicalInstant;
  readonly detail: string;
  readonly needsAction: string | null;
  readonly status: ClaudeDesktopTurnStatus;
}

/** The served Session this root joins to once its transcript is collected; `null` until then. */
export interface WorkRootSession {
  readonly campaignKey: string | null;
  readonly rowId: string;
}

export interface WorkRoot {
  readonly age: WorkRootAge;
  readonly archived: boolean;
  readonly attention: WorkAttentionKind;
  readonly children: WorkRootChildren;
  readonly declared: WorkRootDeclaration | null;
  readonly desktopSessionId: string | null;
  readonly facts: readonly WorkFact[];
  readonly interpretations: readonly WorkInterpretation[];
  readonly key: WorkSessionKey;
  readonly project: WorkRootProject;
  /**
   * The served Session row this root joins to, when the current revision carries one for
   * `key`; the Work view opens session detail through it. `null` also means `project.label`
   * was derived from the Desktop `cwd` rather than read from the report.
   */
  readonly session: WorkRootSession | null;
  readonly title: string;
  readonly titleSource: ClaudeDesktopTitleSource;
}

export interface WorkAttentionCoverage {
  readonly checkouts: {
    readonly failed: number;
    readonly lastRunAt: CanonicalInstant | null;
    readonly observed: number;
  };
  readonly desktopSessions: {
    readonly collectedAt: CanonicalInstant | null;
    readonly filesParsed: number;
    readonly filesSeen: number;
    /** Persisted rows the read refused on re-validation; they exist but could not be shown. */
    readonly refusedRows: number;
    readonly truncated: boolean;
    readonly unsupported: number;
  };
  /**
   * What the Jira producer last did. `reason` is the run's own message when it recorded itself
   * disabled (`jira.enabled: false`, or `acli not installed` at run time); a source never detected
   * leaves no run, so both stay at their defaults and the gap shows as "not observed".
   */
  readonly jira: {
    readonly disabled: boolean;
    readonly failed: number;
    readonly lastRunAt: CanonicalInstant | null;
    readonly observed: number;
    readonly reason: string | null;
  };
  readonly pullRequests: {
    readonly disabled: boolean;
    readonly failed: number;
    readonly lastRunAt: CanonicalInstant | null;
    readonly observed: number;
  };
  /** The join to collected Sessions: which served revision answered, and how many roots it covered. */
  readonly sessions: {
    readonly joined: number;
    /** `null` when no served revision was published; then no root can say whether its transcript was collected. */
    readonly revision: string | null;
    readonly unmatched: number;
  };
}

export interface WorkAttentionDataset {
  readonly coverage: WorkAttentionCoverage;
  readonly generatedAt: CanonicalInstant;
  readonly machineId: string | null;
  readonly roots: readonly WorkRoot[];
  /** Roots that exist beyond `roots`; the page must say the ranking covers a selection. */
  readonly totalRoots: number;
  readonly truncated: boolean;
}
