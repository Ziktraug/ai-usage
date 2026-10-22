import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type BoundedProcessOptions,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type CheckoutStatusObservation,
  type CheckoutStatusOutcome,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';

/**
 * Local fact: what a checkout shows at one instant, read with `git status --porcelain=v2
 * --branch` and `git log -1`. Read-only by construction: the two commands are the only ones this
 * module issues, `--no-optional-locks` keeps `status` from refreshing the index on disk, and the
 * file contents are never read. Counts are entries, not lines; untracked directories stay
 * collapsed as Git reports them. A dirty observation dates the look, not the change.
 */

export interface PorcelainV2Status {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  /** `1`/`2` entries whose worktree column is not `.`; unmerged entries are counted apart. */
  readonly modified: number;
  readonly staged: number;
  readonly unmerged: number;
  readonly untracked: number;
  readonly upstream: string | null;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const AHEAD_BEHIND = /^\+(\d+) -(\d+)$/;
const LINE_SEPARATOR = /\r?\n/;
const OID_HEADER = '# branch.oid ';
const HEAD_HEADER = '# branch.head ';
const UPSTREAM_HEADER = '# branch.upstream ';
const AB_HEADER = '# branch.ab ';

interface MutablePorcelainStatus {
  ahead: number | null;
  behind: number | null;
  branch: string | null | undefined;
  headSha: string | null | undefined;
  modified: number;
  staged: number;
  unmerged: number;
  untracked: number;
  upstream: string | null;
}

const readHeader = (status: MutablePorcelainStatus, line: string): boolean => {
  if (line.startsWith(OID_HEADER)) {
    const value = line.slice(OID_HEADER.length);
    if (value === '(initial)') {
      status.headSha = null;
      return true;
    }
    if (!OBJECT_ID.test(value)) {
      return false;
    }
    status.headSha = value;
    return true;
  }
  if (line.startsWith(HEAD_HEADER)) {
    const value = line.slice(HEAD_HEADER.length);
    status.branch = value === '(detached)' || value.length === 0 ? null : value;
    return true;
  }
  if (line.startsWith(UPSTREAM_HEADER)) {
    const value = line.slice(UPSTREAM_HEADER.length);
    status.upstream = value.length === 0 ? null : value;
    return true;
  }
  if (line.startsWith(AB_HEADER)) {
    const match = AHEAD_BEHIND.exec(line.slice(AB_HEADER.length));
    if (match === null) {
      return false;
    }
    status.ahead = Number(match[1]);
    status.behind = Number(match[2]);
    return true;
  }
  // Porcelain v2 permits additional headers (`# stash N`); they carry nothing this fact needs.
  return line.startsWith('# ');
};

const readEntry = (status: MutablePorcelainStatus, line: string): boolean => {
  if (line.startsWith('1 ') || line.startsWith('2 ')) {
    const xy = line.split(' ', 3)[1];
    if (xy === undefined || xy.length !== 2) {
      return false;
    }
    status.staged += xy[0] === '.' ? 0 : 1;
    status.modified += xy[1] === '.' ? 0 : 1;
    return true;
  }
  if (line.startsWith('u ')) {
    status.unmerged += 1;
    return true;
  }
  if (line.startsWith('? ')) {
    status.untracked += 1;
    return true;
  }
  // `! ` only appears with --ignored, which this module never passes; tolerate it anyway.
  return line.startsWith('! ');
};

/**
 * Parses `git status --porcelain=v2 --branch` (newline-terminated form). Returns `null` for
 * anything outside the documented record types, so a surprising Git never becomes a false count.
 */
export const parsePorcelainV2 = (text: string): PorcelainV2Status | null => {
  const status: MutablePorcelainStatus = {
    ahead: null,
    behind: null,
    branch: undefined,
    headSha: undefined,
    modified: 0,
    staged: 0,
    unmerged: 0,
    untracked: 0,
    upstream: null,
  };
  for (const line of text.split(LINE_SEPARATOR)) {
    if (line.length === 0) {
      continue;
    }
    const accepted = line.startsWith('#') ? readHeader(status, line) : readEntry(status, line);
    if (!accepted) {
      return null;
    }
  }
  if (status.headSha === undefined || status.branch === undefined) {
    return null;
  }
  return {
    ahead: status.ahead,
    behind: status.behind,
    branch: status.branch,
    headSha: status.headSha,
    modified: status.modified,
    staged: status.staged,
    unmerged: status.unmerged,
    untracked: status.untracked,
    upstream: status.upstream,
  };
};

export const CHECKOUT_STATUS_DEFAULTS = {
  maxOutputBytes: 1024 * 1024,
  maxPaths: 100,
  timeoutMs: 5000,
} as const;

export interface ObserveCheckoutStatusOptions {
  readonly machineId: string;
  readonly maxOutputBytes?: number;
  readonly maxPaths?: number;
  readonly now: () => Date;
  readonly paths: readonly string[];
  /** Defaults to the shared bounded runner; tests inject a fake. */
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CheckoutStatusObservationBatch {
  readonly observations: readonly CheckoutStatusObservation[];
  /** Candidate paths that were not absolute, contained NUL or exceeded the path bound. */
  readonly rejected: number;
  readonly truncated: boolean;
}

/** Only PATH, locale and XDG variables are inherited; these are forced on top for every call. */
const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  // In a partial clone a missing object fails the read instead of being fetched from the remote.
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};

/** No fsmonitor, and no automatic maintenance or garbage collection started by an observation. */
const GIT_GLOBAL_ARGUMENTS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
] as const;
const NOT_A_REPOSITORY_EXIT_CODE = 128;

const usableCheckoutPath = (value: string): boolean =>
  path.isAbsolute(value) && !value.includes('\0') && value.length <= WORK_ATTENTION_BOUNDS.maxPath;

type DirectoryProbe = 'available' | 'missing' | 'denied';

const probeDirectory = (checkoutPath: string): Effect.Effect<DirectoryProbe> =>
  Effect.tryPromise(() => stat(checkoutPath)).pipe(
    Effect.map((entry): DirectoryProbe => (entry.isDirectory() ? 'available' : 'missing')),
    Effect.catchAll((error) => {
      const code =
        typeof error === 'object' && error !== null && 'cause' in error && typeof error.cause === 'object'
          ? (error.cause as { code?: unknown } | null)?.code
          : undefined;
      return Effect.succeed<DirectoryProbe>(code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing');
    }),
  );

const emptyObservation = (
  machineId: string,
  checkoutPath: string,
  observedAt: CanonicalInstant,
  outcome: CheckoutStatusOutcome,
): CheckoutStatusObservation => ({
  ahead: null,
  behind: null,
  branch: null,
  checkoutPath,
  dirty: null,
  headSha: null,
  lastCommitAt: null,
  machineId,
  modifiedCount: null,
  observedAt,
  outcome,
  stagedCount: null,
  untrackedCount: null,
  upstream: null,
});

type GitRead =
  | { readonly kind: 'completed'; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' };

const readGit = (
  run: BoundedProcessRunner,
  base: Pick<BoundedProcessOptions, 'maximumOutputBytes' | 'signal' | 'timeoutMs'>,
  checkoutPath: string,
  args: readonly string[],
): Effect.Effect<GitRead> =>
  run({
    ...base,
    args: [...GIT_GLOBAL_ARGUMENTS, '-C', checkoutPath, ...args],
    command: 'git',
    env: GIT_ENVIRONMENT,
  }).pipe(
    Effect.map((result): GitRead => ({ exitCode: result.exitCode, kind: 'completed', stdout: result.stdout })),
    Effect.catchAll((error) =>
      Effect.succeed<GitRead>(error.kind === 'timed-out' ? { kind: 'timeout' } : { kind: 'failed' }),
    ),
  );

const observeOne = (
  options: ObserveCheckoutStatusOptions,
  run: BoundedProcessRunner,
  base: Pick<BoundedProcessOptions, 'maximumOutputBytes' | 'signal' | 'timeoutMs'>,
  checkoutPath: string,
): Effect.Effect<CheckoutStatusObservation> =>
  Effect.gen(function* () {
    const observedAt = canonicalInstantFromDate(options.now());
    const empty = (outcome: CheckoutStatusOutcome) =>
      emptyObservation(options.machineId, checkoutPath, observedAt, outcome);
    const probe = yield* probeDirectory(checkoutPath);
    if (probe !== 'available') {
      return empty(probe);
    }
    const status = yield* readGit(run, base, checkoutPath, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=normal',
    ]);
    if (status.kind !== 'completed') {
      return empty(status.kind === 'timeout' ? 'timeout' : 'invalid');
    }
    if (status.exitCode === NOT_A_REPOSITORY_EXIT_CODE) {
      return empty('not-a-repository');
    }
    if (status.exitCode !== 0) {
      return empty('invalid');
    }
    const parsed = parsePorcelainV2(status.stdout);
    if (parsed === null) {
      return empty('invalid');
    }
    let lastCommitAt: CanonicalInstant | null = null;
    if (parsed.headSha !== null) {
      // An unborn branch has nothing to log; skipping the call keeps the fact deterministic.
      const log = yield* readGit(run, base, checkoutPath, ['log', '-1', '--format=%cI']);
      if (log.kind === 'timeout') {
        return empty('timeout');
      }
      if (log.kind === 'completed' && log.exitCode === 0) {
        lastCommitAt = normalizeIsoTimestamp(log.stdout.trim());
      }
    }
    const modifiedCount = parsed.modified + parsed.unmerged;
    return {
      ahead: parsed.ahead,
      behind: parsed.behind,
      branch: parsed.branch,
      checkoutPath,
      dirty: parsed.staged + modifiedCount + parsed.untracked > 0,
      headSha: parsed.headSha,
      lastCommitAt,
      machineId: options.machineId,
      modifiedCount,
      observedAt,
      outcome: 'observed',
      stagedCount: parsed.staged,
      untrackedCount: parsed.untracked,
      upstream: parsed.upstream,
    };
  });

/**
 * Observes each candidate path once, in order, deduplicated after `path.resolve`, up to
 * `maxPaths`. Never fails: every path ends as an observation with an outcome, and a Git or
 * filesystem problem is recorded against that path alone.
 */
export const observeCheckoutStatus = (
  options: ObserveCheckoutStatusOptions,
): Effect.Effect<CheckoutStatusObservationBatch> =>
  Effect.gen(function* () {
    const run = options.run ?? runBoundedProcess;
    const maxPaths = options.maxPaths ?? CHECKOUT_STATUS_DEFAULTS.maxPaths;
    const base = {
      maximumOutputBytes: options.maxOutputBytes ?? CHECKOUT_STATUS_DEFAULTS.maxOutputBytes,
      timeoutMs: options.timeoutMs ?? CHECKOUT_STATUS_DEFAULTS.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const unique: string[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    for (const candidate of options.paths) {
      if (!usableCheckoutPath(candidate)) {
        rejected += 1;
        continue;
      }
      const resolved = path.resolve(candidate);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        unique.push(resolved);
      }
    }
    const selected = unique.slice(0, maxPaths);
    const observations: CheckoutStatusObservation[] = [];
    for (const checkoutPath of selected) {
      observations.push(yield* observeOne(options, run, base, checkoutPath));
    }
    return { observations, rejected, truncated: unique.length > selected.length };
  });
