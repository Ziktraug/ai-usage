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
  PULL_REQUEST_STATES,
  type PullRequestCheckRollup,
  type PullRequestObservation,
  type PullRequestObservationOutcome,
  type PullRequestState,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';

/**
 * External fact: what GitHub shows for one explicitly linked pull request at one instant, read
 * through the operator's own `gh` CLI and credentials. The engine never holds a token of its own:
 * by default the CLI's active account answers; when the local config names an account for an
 * owner, its token is obtained with `gh auth token --user` for this run only and handed to the
 * read through `GH_TOKEN`, never stored, logged or echoed into an observation.
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
  'mergedAt',
  'updatedAt',
  'title',
  'url',
  'headRefName',
  'baseRefName',
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

const linkKey = (link: PullRequestLink): string => JSON.stringify([link.host, link.repository, link.number]);

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
  return { host, number: link.number, repository };
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
  draft: null,
  headRef: null,
  host: link.host,
  machineId: context.machineId,
  mergedAt: null,
  number: link.number,
  observedAt: context.observedAt,
  outcome,
  outcomeMessage: outcomeMessage.slice(0, maxDetailText),
  repository: link.repository,
  reviewDecision: null,
  state: null,
  title: null,
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
  readonly draft: boolean;
  readonly headRef: string;
  readonly mergedAt: CanonicalInstant | null;
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
  const mergedAt = optionalInstant(value.mergedAt);
  const updatedAt = normalizeIsoTimestamp(value.updatedAt);
  const title = boundedText(value.title, maxShortText);
  const headRef = boundedText(value.headRefName, maxShortText);
  const baseRef = boundedText(value.baseRefName, maxShortText);
  const url = typeof value.url === 'string' && value.url.length <= maxPath ? value.url : undefined;
  let urlMatchesLink = false;
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      urlMatchesLink =
        parsed.protocol === 'https:' &&
        parsed.hostname === link.host &&
        parsed.pathname === `/${link.repository}/pull/${String(link.number)}`;
    } catch {
      urlMatchesLink = false;
    }
  }
  if (
    state === undefined ||
    draft === undefined ||
    reviewDecision === undefined ||
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
    draft,
    headRef,
    mergedAt,
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
      return {
        halt: null,
        observation: {
          accountLabel: context.accountLabel,
          baseRef: parsed.baseRef,
          checksRollup: parsed.checksRollup,
          draft: parsed.draft,
          headRef: parsed.headRef,
          host: link.host,
          machineId: context.machineId,
          mergedAt: parsed.mergedAt,
          number: link.number,
          observedAt,
          outcome: 'observed',
          outcomeMessage: null,
          repository: link.repository,
          reviewDecision: parsed.reviewDecision,
          state: parsed.state,
          title: parsed.title,
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
  ghUser: string,
  environment: Readonly<Record<string, string>>,
): Effect.Effect<{ readonly token: string } | { readonly failure: Classification }> =>
  Effect.gen(function* () {
    const read = yield* gh({ ...context, environment }, [
      'auth',
      'token',
      '--user',
      ghUser,
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
          message: `gh has no stored token for ${ghUser} on ${SUPPORTED_GITHUB_HOST}`,
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
 * an offline machine costs at most two process spawns per cycle. Never fails.
 */
export const observePullRequests = (options: ObservePullRequestsOptions): Effect.Effect<PullRequestObservationBatch> =>
  Effect.gen(function* () {
    const maxLinks = options.maxLinks ?? GITHUB_PULL_REQUEST_DEFAULTS.maxLinks;
    const unique: PullRequestLink[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    for (const candidate of options.links) {
      const link = normalizeLink(candidate);
      if (link === null) {
        rejected += 1;
        continue;
      }
      const key = linkKey(link);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(link);
      }
    }
    const selected = unique.slice(0, maxLinks);
    const truncated = unique.length > selected.length;
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
    if (options.account !== undefined) {
      const resolved = yield* resolveAccountToken(baseContext, options.account.ghUser, baseEnvironment);
      if ('failure' in resolved) {
        halt = resolved.failure;
      } else {
        // The token lives in this closure for the duration of the batch and reaches `gh` only as
        // the GH_TOKEN variable of the calls below.
        environment = { ...baseEnvironment, GH_TOKEN: resolved.token };
      }
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
