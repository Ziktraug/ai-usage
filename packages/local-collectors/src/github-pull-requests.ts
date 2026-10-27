import {
  type BoundedProcessError,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  PULL_REQUEST_HISTORY_BOUNDS,
  PULL_REQUEST_STATES,
  type PullRequestCheckRollup,
  type PullRequestHistory,
  type PullRequestMilestone,
  type PullRequestObservation,
  type PullRequestObservationOutcome,
  type PullRequestState,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';

/**
 * External fact: what GitHub shows for one explicitly linked pull request at one instant, read
 * through the operator's own `gh` CLI and credentials. The engine never holds a token of its own:
 * one `gh auth token` read selects the active account, or `--user` selects the locally configured
 * account for an owner. Its token is handed to every read through `GH_TOKEN` for this batch only,
 * never stored, logged or echoed into an observation.
 *
 * `gh` writes its diagnostics to stderr, which the bounded runner discards. Failures are
 * therefore classified from exit codes and from stdout alone:
 *
 * - exit 4 is `gh`'s documented "authentication required" (no credentials at all);
 * - any other non-zero exit with no stdout is followed by one bounded REST read
 *   (`gh api repos/{owner}/{name}/pulls/{number}`), whose error body `gh` prints on stdout:
 *   HTTP 404 is `not-found`, HTTP 401 is `unauthenticated`, anything else or no body is
 *   `network` with the status in the message.
 *
 * A failed observation keeps its outcome and leaves every GitHub-reported field null, so the last
 * successful observation remains the latest fact and the failure stays visible beside it.
 */

export interface PullRequestLink {
  readonly discoveryRole?: 'author' | 'review-requested' | 'team-review-requested' | null;
  readonly host: string;
  readonly number: number;
  /** `owner/name`. */
  readonly repository: string;
}

export const GITHUB_PULL_REQUEST_DEFAULTS = {
  maxLinks: 40,
  maxOutputBytes: 1024 * 1024,
  timeoutMs: 10_000,
} as const;

export const SUPPORTED_GITHUB_HOST = 'github.com';

export interface ObservePullRequestsOptions {
  /** A `gh`-known login whose stored token answers this batch; absent means the CLI's active account. */
  readonly account?: { readonly ghUser: string };
  /** Variables handed to `gh` by name on top of the runner allow-list (keyring access on Linux). */
  readonly environment?: Readonly<Record<string, string>>;
  readonly links: readonly PullRequestLink[];
  readonly machineId: string;
  readonly maxLinks?: number;
  readonly maxOutputBytes?: number;
  readonly now: () => Date;
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PullRequestObservationBatch {
  /** The `gh` login used, or null for the CLI's active account (not resolved here). */
  readonly accountLabel: string | null;
  readonly observations: readonly PullRequestObservation[];
  /** Links that were malformed (empty host, repository not `owner/name`, number not positive). */
  readonly rejected: number;
  readonly truncated: boolean;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const PULL_REQUEST_FIELDS = [
  'state',
  'isDraft',
  'reviewDecision',
  'createdAt',
  'closedAt',
  'mergedAt',
  'mergeable',
  'mergeStateStatus',
  'updatedAt',
  'title',
  'url',
  'headRefName',
  'baseRefName',
  'isCrossRepository',
  'statusCheckRollup',
] as const;
const GH_AUTHENTICATION_REQUIRED_EXIT_CODE = 4;
const CHECK_SUCCESS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const CHECK_FAILURE = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT']);
const CHECK_PENDING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING']);

/** Forced for every `gh` call: no prompts, no pager, no colour, no update check. */
const GH_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLICOLOR: '0',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: 'cat',
  GH_PROMPT_DISABLED: '1',
  NO_COLOR: '1',
};

const { maxDetailText, maxPath, maxShortText } = WORK_ATTENTION_BOUNDS;

const linkKey = (link: PullRequestLink): string =>
  JSON.stringify([link.host, link.repository.toLowerCase(), link.number]);

const normalizeLink = (link: PullRequestLink): PullRequestLink | null => {
  const host = typeof link.host === 'string' ? link.host.trim().toLowerCase() : '';
  const repository = typeof link.repository === 'string' ? link.repository.trim() : '';
  if (
    host.length === 0 ||
    host.length > maxShortText ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository.length > maxShortText ||
    !Number.isSafeInteger(link.number) ||
    link.number <= 0
  ) {
    return null;
  }
  return { discoveryRole: link.discoveryRole ?? null, host, number: link.number, repository };
};

const failedObservation = (
  context: { readonly accountLabel: string | null; readonly machineId: string; readonly observedAt: CanonicalInstant },
  link: PullRequestLink,
  outcome: Exclude<PullRequestObservationOutcome, 'observed'>,
  outcomeMessage: string,
): PullRequestObservation => ({
  accountLabel: context.accountLabel,
  baseRef: null,
  checksRollup: null,
  closedAt: null,
  createdAt: null,
  discoveryRole: link.discoveryRole ?? null,
  draft: null,
  headRef: null,
  host: link.host,
  machineId: context.machineId,
  mergeable: null,
  mergedAt: null,
  mergeStateStatus: null,
  number: link.number,
  observedAt: context.observedAt,
  outcome,
  outcomeMessage: outcomeMessage.slice(0, maxDetailText),
  repository: link.repository,
  reviewDecision: null,
  state: null,
  title: null,
  unresolvedReviewThreads: null,
  updatedAt: null,
  url: null,
});

/** One check item's effective status: a status context's `state`, or a check run's conclusion once completed. */
const checkItemStatus = (item: unknown): string | null => {
  if (!isRecord(item)) {
    return null;
  }
  if (typeof item.state === 'string') {
    return item.state;
  }
  if (item.status === 'COMPLETED' && typeof item.conclusion === 'string') {
    return item.conclusion;
  }
  return typeof item.status === 'string' ? item.status : null;
};

export const rollupChecks = (items: unknown): PullRequestCheckRollup => {
  if (!Array.isArray(items) || items.length === 0) {
    return 'unknown';
  }
  let pending = false;
  let unknown = false;
  for (const item of items) {
    const status = checkItemStatus(item);
    if (status === null) {
      unknown = true;
    } else if (CHECK_FAILURE.has(status)) {
      return 'failure';
    } else if (CHECK_PENDING.has(status)) {
      pending = true;
    } else if (!CHECK_SUCCESS.has(status)) {
      unknown = true;
    }
  }
  if (pending) {
    return 'pending';
  }
  return unknown ? 'unknown' : 'success';
};

interface ParsedPullRequest {
  readonly baseRef: string;
  readonly checksRollup: PullRequestCheckRollup;
  readonly closedAt: CanonicalInstant | null;
  readonly createdAt: CanonicalInstant | null;
  /** True when the head branch lives in another repository (a fork); absent when not reported. */
  readonly crossRepository: boolean | null;
  readonly draft: boolean;
  readonly headRef: string;
  readonly lifecycleDateMessage: string | null;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  readonly mergedAt: CanonicalInstant | null;
  readonly mergeStateStatus: string | null;
  readonly reviewDecision: string | null;
  readonly state: PullRequestState;
  readonly title: string;
  readonly updatedAt: CanonicalInstant;
  readonly url: string;
}

const optionalInstant = (value: unknown): CanonicalInstant | null | undefined => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return normalizeIsoTimestamp(value) ?? undefined;
};

/** Malformed optional lifecycle dates must not discard the rest of a successful PR read. */
const lifecycleInstant = (value: unknown): CanonicalInstant | null | undefined => {
  try {
    return optionalInstant(value);
  } catch {
    // JSON objects can also fail the normalizer's string conversion.
    return undefined;
  }
};

const boundedText = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, maximum) : undefined;

/** Strict read of `gh pr view --json`: expected keys with expected types, unknown keys ignored. */
export const parsePullRequestView = (stdout: string, link: PullRequestLink): ParsedPullRequest | null => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const state =
    typeof value.state === 'string' && (PULL_REQUEST_STATES as readonly string[]).includes(value.state)
      ? (value.state as PullRequestState)
      : undefined;
  const draft = typeof value.isDraft === 'boolean' ? value.isDraft : undefined;
  const reviewDecision =
    value.reviewDecision === null || value.reviewDecision === undefined || value.reviewDecision === ''
      ? null
      : boundedText(value.reviewDecision, maxShortText);
  const validMergeable =
    value.mergeable === 'MERGEABLE' || value.mergeable === 'CONFLICTING' || value.mergeable === 'UNKNOWN'
      ? value.mergeable
      : undefined;
  const mergeable = value.mergeable === undefined || value.mergeable === null ? null : validMergeable;
  const mergeStateStatus =
    value.mergeStateStatus === undefined || value.mergeStateStatus === null
      ? null
      : boundedText(value.mergeStateStatus, maxShortText);
  const createdAt = lifecycleInstant(value.createdAt);
  const closedAt = lifecycleInstant(value.closedAt);
  const invalidDates = [
    createdAt === undefined ? 'createdAt' : null,
    closedAt === undefined ? 'closedAt' : null,
  ].filter((field) => field !== null);
  const mergedAt = optionalInstant(value.mergedAt);
  const updatedAt = normalizeIsoTimestamp(value.updatedAt);
  const title = boundedText(value.title, maxShortText);
  const headRef = boundedText(value.headRefName, maxShortText);
  const baseRef = boundedText(value.baseRefName, maxShortText);
  const crossRepository = typeof value.isCrossRepository === 'boolean' ? value.isCrossRepository : null;
  const url = typeof value.url === 'string' && value.url.length <= maxPath ? value.url : undefined;
  let urlMatchesLink = false;
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/');
      urlMatchesLink =
        parsed.protocol === 'https:' &&
        parsed.hostname === link.host &&
        segments.length === 5 &&
        `${segments[1]}/${segments[2]}`.toLowerCase() === link.repository.toLowerCase() &&
        segments[3] === 'pull' &&
        segments[4] === String(link.number);
    } catch {
      urlMatchesLink = false;
    }
  }
  if (
    state === undefined ||
    draft === undefined ||
    reviewDecision === undefined ||
    mergeable === undefined ||
    mergeStateStatus === undefined ||
    mergedAt === undefined ||
    updatedAt === null ||
    title === undefined ||
    headRef === undefined ||
    baseRef === undefined ||
    url === undefined ||
    !urlMatchesLink ||
    !(
      value.statusCheckRollup === null ||
      value.statusCheckRollup === undefined ||
      Array.isArray(value.statusCheckRollup)
    )
  ) {
    return null;
  }
  return {
    baseRef,
    checksRollup: rollupChecks(value.statusCheckRollup),
    closedAt: closedAt ?? null,
    createdAt: createdAt ?? null,
    crossRepository,
    draft,
    headRef,
    lifecycleDateMessage: invalidDates.length > 0 ? `Invalid lifecycle dates: ${invalidDates.join(', ')}` : null,
    mergeable,
    mergedAt,
    mergeStateStatus,
    reviewDecision,
    state,
    title,
    updatedAt,
    url,
  };
};

type GhRead =
  | { readonly kind: 'completed'; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'output-limit' }
  | { readonly kind: 'failed' };

interface RunContext {
  readonly accountLabel: string | null;
  readonly base: Pick<BoundedProcessOptions, 'maximumOutputBytes' | 'signal' | 'timeoutMs'>;
  readonly environment: Readonly<Record<string, string>>;
  readonly machineId: string;
  readonly now: () => Date;
  readonly run: BoundedProcessRunner;
}

const ghReadFailure = (kind: BoundedProcessError['kind']): GhRead => {
  switch (kind) {
    case 'timed-out':
      return { kind: 'timeout' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'output-limit':
      return { kind: 'output-limit' };
    default:
      return { kind: 'failed' };
  }
};

const gh = (context: RunContext, args: readonly string[]): Effect.Effect<GhRead> =>
  context.run({ ...context.base, args, command: 'gh', env: context.environment }).pipe(
    Effect.map((result): GhRead => ({ exitCode: result.exitCode, kind: 'completed', stdout: result.stdout })),
    Effect.catch((error) => Effect.succeed<GhRead>(ghReadFailure(error.kind))),
  );

interface Classification {
  /** Whether later links in this run should be skipped with the same outcome. */
  readonly haltsRun: boolean;
  readonly message: string;
  readonly outcome: Exclude<PullRequestObservationOutcome, 'observed'>;
}

const classifyRestError = (read: GhRead): Classification => {
  if (read.kind === 'timeout') {
    return { haltsRun: true, message: 'gh timed out during the follow-up REST read', outcome: 'timeout' };
  }
  if (read.kind !== 'completed') {
    return { haltsRun: false, message: `gh follow-up REST read ${read.kind}`, outcome: 'invalid' };
  }
  const body = read.stdout.trim();
  if (body.length === 0) {
    return {
      haltsRun: true,
      message: 'gh exited 1 without output (network failure or not found)',
      outcome: 'network',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { haltsRun: false, message: 'gh follow-up REST read returned an unreadable body', outcome: 'invalid' };
  }
  if (read.exitCode === 0) {
    return {
      haltsRun: false,
      message: 'gh pr view failed although the REST read of the same pull request succeeded',
      outcome: 'invalid',
    };
  }
  const status = isRecord(value) && typeof value.status === 'string' ? value.status : null;
  if (status === '404') {
    return {
      haltsRun: false,
      message: 'GitHub returned HTTP 404 (not found or not visible to this account)',
      outcome: 'not-found',
    };
  }
  if (status === '401') {
    return { haltsRun: true, message: 'GitHub rejected the credentials (HTTP 401)', outcome: 'unauthenticated' };
  }
  if (status === '403') {
    return { haltsRun: false, message: 'GitHub returned HTTP 403 (forbidden or rate limited)', outcome: 'network' };
  }
  return {
    haltsRun: false,
    message: status === null ? 'GitHub returned an error without an HTTP status' : `GitHub returned HTTP ${status}`,
    outcome: 'network',
  };
};

/**
 * One GraphQL read per pull request: unresolved review threads (counted on an open pull request
 * only) and the status history. Reviews are filtered to approvals and change requests server-side,
 * timeline items to draft, ready, close and reopen events, so comment traffic never fills the
 * bounds; `last` keeps the newest when a connection holds more.
 */
const PULL_REQUEST_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { totalCount nodes { isResolved } } reviews(last: ${String(PULL_REQUEST_HISTORY_BOUNDS.maxReviews)}, states: [APPROVED, CHANGES_REQUESTED]) { totalCount nodes { state submittedAt author { login } } } timelineItems(last: ${String(PULL_REQUEST_HISTORY_BOUNDS.maxTimelineEvents)}, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, CLOSED_EVENT, REOPENED_EVENT]) { totalCount nodes { __typename ... on ReadyForReviewEvent { createdAt actor { login } } ... on ConvertToDraftEvent { createdAt actor { login } } ... on ClosedEvent { createdAt actor { login } } ... on ReopenedEvent { createdAt actor { login } } } } } } }`;
interface ReviewThreadRead {
  readonly count: number | null;
  readonly message: string | null;
}
const unknownReviewThreads = (reason: string): ReviewThreadRead => ({
  count: null,
  message: `Review threads unavailable: ${reason}`,
});

interface HistoryRead {
  readonly history: PullRequestHistory | null;
  readonly message: string | null;
}
const unknownHistory = (reason: string): HistoryRead => ({
  history: null,
  message: `Status history unavailable: ${reason}`,
});

/** Only a complete connection establishes a count; partial GraphQL data never establishes zero. */
const parseReviewThreads = (pullRequest: Record<string, unknown>): ReviewThreadRead => {
  const connection = pullRequest.reviewThreads;
  if (
    !isRecord(connection) ||
    typeof connection.totalCount !== 'number' ||
    !Number.isSafeInteger(connection.totalCount) ||
    connection.totalCount < 0
  ) {
    return unknownReviewThreads('invalid review thread connection');
  }
  if (connection.totalCount > 100) {
    return unknownReviewThreads('more than 100 threads; count is incomplete');
  }
  if (!Array.isArray(connection.nodes) || connection.nodes.length !== connection.totalCount) {
    return unknownReviewThreads('incomplete review thread connection');
  }
  let count = 0;
  for (const node of connection.nodes) {
    if (!isRecord(node) || typeof node.isResolved !== 'boolean') {
      return unknownReviewThreads('invalid review thread node');
    }
    if (!node.isResolved) {
      count += 1;
    }
  }
  return { count, message: null };
};

const REVIEW_MILESTONES = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested' } as const;
const TIMELINE_MILESTONES = {
  ReadyForReviewEvent: 'ready-for-review',
  ConvertToDraftEvent: 'converted-to-draft',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
} as const;

/** A deleted account is reported as a null author; that leaves the milestone without an actor. */
const loginOf = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return isRecord(value) && typeof value.login === 'string' && value.login.length > 0
    ? value.login.slice(0, maxShortText)
    : undefined;
};

/** `null` when the connection is malformed; `complete` is false when it held more than it returned. */
const historyConnection = (
  value: unknown,
  milestoneOf: (node: Record<string, unknown>) => PullRequestMilestone | null,
): { readonly complete: boolean; readonly items: readonly PullRequestMilestone[] } | null => {
  if (
    !isRecord(value) ||
    typeof value.totalCount !== 'number' ||
    !Number.isSafeInteger(value.totalCount) ||
    value.totalCount < 0 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > value.totalCount
  ) {
    return null;
  }
  const items: PullRequestMilestone[] = [];
  for (const node of value.nodes) {
    const item = isRecord(node) ? milestoneOf(node) : null;
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return { complete: value.nodes.length === value.totalCount, items };
};

const reviewMilestone = (node: Record<string, unknown>): PullRequestMilestone | null => {
  const kind = node.state === 'APPROVED' || node.state === 'CHANGES_REQUESTED' ? REVIEW_MILESTONES[node.state] : null;
  const at = lifecycleInstant(node.submittedAt);
  const actor = loginOf(node.author);
  return kind === null || at === undefined || at === null || actor === undefined ? null : { actor, at, kind };
};

const timelineMilestone = (node: Record<string, unknown>): PullRequestMilestone | null => {
  const kind =
    typeof node.__typename === 'string' && Object.hasOwn(TIMELINE_MILESTONES, node.__typename)
      ? TIMELINE_MILESTONES[node.__typename as keyof typeof TIMELINE_MILESTONES]
      : null;
  const at = lifecycleInstant(node.createdAt);
  const actor = loginOf(node.actor);
  return kind === null || at === undefined || at === null || actor === undefined ? null : { actor, at, kind };
};

const parseHistory = (pullRequest: Record<string, unknown>): HistoryRead => {
  const reviews = historyConnection(pullRequest.reviews, reviewMilestone);
  const timeline = historyConnection(pullRequest.timelineItems, timelineMilestone);
  if (reviews === null || timeline === null) {
    return unknownHistory(reviews === null ? 'invalid review connection' : 'invalid timeline connection');
  }
  const items = [...reviews.items, ...timeline.items].sort(
    (left, right) => left.at.localeCompare(right.at) || left.kind.localeCompare(right.kind),
  );
  return { history: { complete: reviews.complete && timeline.complete, items }, message: null };
};

interface DetailRead {
  readonly history: HistoryRead;
  readonly reviewThreads: ReviewThreadRead;
}
const unknownDetail = (reason: string): DetailRead => ({
  history: unknownHistory(reason),
  reviewThreads: unknownReviewThreads(reason),
});

/** Errors anywhere in the response establish nothing: GraphQL may return partial data beside them. */
const parsePullRequestDetail = (stdout: string): DetailRead => {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return unknownDetail('invalid GraphQL response');
  }
  if (!isRecord(body) || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0))) {
    return unknownDetail('GraphQL response contains errors');
  }
  const repository = isRecord(body.data) ? body.data.repository : undefined;
  const pullRequest = isRecord(repository) ? repository.pullRequest : undefined;
  if (!isRecord(pullRequest)) {
    return unknownDetail('invalid pull request node');
  }
  return { history: parseHistory(pullRequest), reviewThreads: parseReviewThreads(pullRequest) };
};

const observeDetail = (context: RunContext, link: PullRequestLink): Effect.Effect<DetailRead> =>
  Effect.gen(function* () {
    const [owner, name] = link.repository.split('/');
    const response = yield* gh(context, [
      'api',
      'graphql',
      '-f',
      `query=${PULL_REQUEST_DETAIL_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${String(link.number)}`,
    ]);
    if (response.kind !== 'completed') {
      return unknownDetail(`gh ${response.kind}`);
    }
    if (response.exitCode !== 0) {
      return unknownDetail(`gh exited ${String(response.exitCode)}`);
    }
    return parsePullRequestDetail(response.stdout);
  }).pipe(Effect.catchDefect(() => Effect.succeed(unknownDetail('gh runner failed'))));

const observeLink = (
  context: RunContext,
  link: PullRequestLink,
): Effect.Effect<{ readonly observation: PullRequestObservation; readonly halt: Classification | null }> =>
  Effect.gen(function* () {
    const observedAt = canonicalInstantFromDate(context.now());
    const failure = (classification: Classification) => ({
      halt: classification.haltsRun ? classification : null,
      observation: failedObservation(
        { accountLabel: context.accountLabel, machineId: context.machineId, observedAt },
        link,
        classification.outcome,
        classification.message,
      ),
    });
    const view = yield* gh(context, [
      'pr',
      'view',
      String(link.number),
      '--repo',
      link.repository,
      '--json',
      PULL_REQUEST_FIELDS.join(','),
    ]);
    if (view.kind === 'timeout') {
      return failure({ haltsRun: true, message: 'gh timed out', outcome: 'timeout' });
    }
    if (view.kind === 'unavailable') {
      return failure({ haltsRun: true, message: 'gh is not installed', outcome: 'disabled' });
    }
    if (view.kind === 'output-limit') {
      return failure({ haltsRun: false, message: 'gh output exceeded the size ceiling', outcome: 'invalid' });
    }
    if (view.kind === 'failed') {
      return failure({ haltsRun: false, message: 'gh output could not be read', outcome: 'invalid' });
    }
    if (view.exitCode === 0) {
      const parsed = parsePullRequestView(view.stdout, link);
      if (parsed === null) {
        return failure({
          haltsRun: false,
          message: 'gh returned an unexpected pull request shape',
          outcome: 'invalid',
        });
      }
      const detail = yield* observeDetail(context, link);
      // Unresolved threads only matter, and are only counted, while the pull request is open.
      const reviewThreads = parsed.state === 'OPEN' ? detail.reviewThreads : { count: null, message: null };
      return {
        halt: null,
        observation: {
          accountLabel: context.accountLabel,
          baseRef: parsed.baseRef,
          checksRollup: parsed.checksRollup,
          closedAt: parsed.closedAt,
          createdAt: parsed.createdAt,
          ...(parsed.crossRepository === null ? {} : { crossRepository: parsed.crossRepository }),
          discoveryRole: link.discoveryRole ?? null,
          draft: parsed.draft,
          headRef: parsed.headRef,
          ...(detail.history.history === null ? {} : { history: detail.history.history }),
          host: link.host,
          machineId: context.machineId,
          mergeable: parsed.mergeable,
          mergedAt: parsed.mergedAt,
          mergeStateStatus: parsed.mergeStateStatus,
          number: link.number,
          observedAt,
          outcome: 'observed',
          outcomeMessage:
            [reviewThreads.message, detail.history.message, parsed.lifecycleDateMessage]
              .filter((message) => message !== null)
              .join('; ') || null,
          repository: link.repository,
          reviewDecision: parsed.reviewDecision,
          state: parsed.state,
          title: parsed.title,
          unresolvedReviewThreads: reviewThreads.count,
          updatedAt: parsed.updatedAt,
          url: parsed.url,
        },
      };
    }
    if (view.exitCode === GH_AUTHENTICATION_REQUIRED_EXIT_CODE) {
      return failure({
        haltsRun: true,
        message: 'gh reported that authentication is required (exit 4)',
        outcome: 'unauthenticated',
      });
    }
    if (view.stdout.trim().length > 0) {
      return failure({
        haltsRun: false,
        message: `gh exited ${String(view.exitCode)} with unexpected output`,
        outcome: 'invalid',
      });
    }
    const rest = yield* gh(context, ['api', `repos/${link.repository}/pulls/${String(link.number)}`]);
    return failure(classifyRestError(rest));
  });

const resolveAccountToken = (
  context: Omit<RunContext, 'environment'>,
  ghUser: string | null,
  environment: Readonly<Record<string, string>>,
): Effect.Effect<{ readonly token: string } | { readonly failure: Classification }> =>
  Effect.gen(function* () {
    const read = yield* gh({ ...context, environment }, [
      'auth',
      'token',
      ...(ghUser === null ? [] : ['--user', ghUser]),
      '--hostname',
      SUPPORTED_GITHUB_HOST,
    ]);
    if (read.kind === 'timeout') {
      return {
        failure: { haltsRun: true, message: 'gh timed out while reading the account token', outcome: 'timeout' },
      };
    }
    if (read.kind === 'unavailable') {
      return { failure: { haltsRun: true, message: 'gh is not installed', outcome: 'disabled' } };
    }
    if (read.kind !== 'completed' || read.exitCode !== 0 || read.stdout.trim().length === 0) {
      return {
        failure: {
          haltsRun: true,
          message: `gh has no stored token for ${ghUser ?? 'the active account'} on ${SUPPORTED_GITHUB_HOST}`,
          outcome: 'unauthenticated',
        },
      };
    }
    return { token: read.stdout.trim() };
  });

/**
 * Observes each distinct link once, in order, up to `maxLinks`. Hosts other than github.com are
 * recorded as `disabled`. After a run-halting failure (timeout, missing `gh`, no credentials,
 * network silence) the remaining links are recorded with that outcome without another call, so
 * an offline machine costs at most three process spawns per cycle (token, view, REST). Each
 * successful OPEN view adds one bounded review-thread read; its failure never halts later links. Never fails.
 */
export const observePullRequests = (options: ObservePullRequestsOptions): Effect.Effect<PullRequestObservationBatch> =>
  Effect.gen(function* () {
    const maxLinks = options.maxLinks ?? GITHUB_PULL_REQUEST_DEFAULTS.maxLinks;
    const unique = new Map<string, PullRequestLink>();
    let rejected = 0;
    for (const candidate of options.links) {
      const link = normalizeLink(candidate);
      if (link === null) {
        rejected += 1;
        continue;
      }
      const key = linkKey(link);
      const first = unique.get(key);
      const discoveryRole = link.discoveryRole ?? null;
      if (first === undefined) {
        unique.set(key, link);
      } else if (first.discoveryRole === null && discoveryRole !== null) {
        unique.set(key, { ...first, discoveryRole });
      }
    }
    const selected = [...unique.values()].slice(0, maxLinks);
    const truncated = unique.size > selected.length;
    const accountLabel = options.account?.ghUser ?? null;
    const baseContext: Omit<RunContext, 'environment'> = {
      accountLabel,
      base: {
        maximumOutputBytes: options.maxOutputBytes ?? GITHUB_PULL_REQUEST_DEFAULTS.maxOutputBytes,
        timeoutMs: options.timeoutMs ?? GITHUB_PULL_REQUEST_DEFAULTS.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      machineId: options.machineId,
      now: options.now,
      run: options.run ?? runBoundedProcess,
    };
    const baseEnvironment = { ...GH_ENVIRONMENT, ...options.environment };
    const observations: PullRequestObservation[] = [];
    const supported = selected.filter((link) => link.host === SUPPORTED_GITHUB_HOST);
    for (const link of selected) {
      if (link.host !== SUPPORTED_GITHUB_HOST) {
        observations.push(
          failedObservation(
            { accountLabel, machineId: options.machineId, observedAt: canonicalInstantFromDate(options.now()) },
            link,
            'disabled',
            'host not supported in this version',
          ),
        );
      }
    }
    if (supported.length === 0) {
      return { accountLabel, observations, rejected, truncated };
    }
    let halt: Classification | null = null;
    let environment: Readonly<Record<string, string>> = baseEnvironment;
    // Resolve even the active account explicitly: automatic credential lookup in `gh pr view`
    // can fail under the engine while the bounded `gh auth token` read succeeds.
    const resolved = yield* resolveAccountToken(baseContext, options.account?.ghUser ?? null, baseEnvironment);
    if ('failure' in resolved) {
      halt = resolved.failure;
    } else {
      // The token stays in this batch and reaches `gh` only through its environment.
      environment = { ...baseEnvironment, GH_TOKEN: resolved.token };
    }
    const context: RunContext = { ...baseContext, environment };
    for (const link of supported) {
      if (halt !== null) {
        observations.push(
          failedObservation(
            { accountLabel, machineId: options.machineId, observedAt: canonicalInstantFromDate(options.now()) },
            link,
            halt.outcome,
            `not attempted: ${halt.message}`,
          ),
        );
        continue;
      }
      const result = yield* observeLink(context, link);
      observations.push(result.observation);
      halt = result.halt;
    }
    return { accountLabel, observations, rejected, truncated };
  });
