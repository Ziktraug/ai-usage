import {
  BoundedProcessError,
  boundedProcessEnvironment,
  executeBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';

/**
 * The one way the review and delegation code runs `git` in an operator's checkout: the shared
 * bounded runner (no shell, allow-listed environment, deadline, output ceiling, stderr discarded)
 * with the global options and environment that keep every read side-effect free. The scope
 * preparation (`claude-review-scope.ts`) and the delegation checkout facts
 * (`delegation-checkout.ts`) both go through here; each maps the runner's failures to its own
 * vocabulary.
 */
export type GitRunFailureKind = 'not-text' | 'output-limit' | 'signalled' | 'timed-out' | 'unavailable';

export class GitRunError extends Error {
  readonly kind: GitRunFailureKind;
  /** The git subcommand (`rev-parse`, `diff-tree`…), for messages; never the operands. */
  readonly subcommand: string;

  constructor(kind: GitRunFailureKind, subcommand: string) {
    super(`git ${subcommand} ${kind}`);
    this.name = 'GitRunError';
    this.kind = kind;
    this.subcommand = subcommand;
  }
}

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_SMALL_OUTPUT_BYTES = 1024 * 1024;

/**
 * Global options of every call: no pager, no optional lock, raw non-ASCII paths, no fsmonitor, no
 * colour, and no automatic maintenance or garbage collection started in the operator's repository.
 */
export const GIT_GLOBAL_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'color.ui=never',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
] as const;

/**
 * Forced on every call: no prompt, no optional lock, and no lazy fetch. In a partial clone a
 * missing object would otherwise be fetched from the promisor remote (network, credential
 * helpers, a new pack in `.git/objects`); with `GIT_NO_LAZY_FETCH` the read fails instead.
 */
export const GIT_SCOPE_ENVIRONMENT = {
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/** The allow-listed subset of `source` plus the forced git variables. */
export const gitScopeEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => ({
  ...boundedProcessEnvironment({}, source),
  ...GIT_SCOPE_ENVIRONMENT,
});

export interface GitAnswer {
  readonly exitCode: number;
  readonly stdout: string;
}

export const runGit = async (
  checkoutPath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  maximumOutputBytes: number,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitAnswer> => {
  const subcommand = args[0] ?? 'git';
  try {
    return await executeBoundedProcess({
      args: [...GIT_GLOBAL_OPTIONS, ...args],
      command: 'git',
      cwd: checkoutPath,
      env: environment,
      maximumOutputBytes,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      if (error.kind === 'output-limit') {
        throw new GitRunError('output-limit', subcommand);
      }
      if (error.kind === 'failed') {
        throw new GitRunError(error.failure === 'undecodable' ? 'not-text' : 'signalled', subcommand);
      }
      throw new GitRunError(error.kind, subcommand);
    }
    throw error;
  }
};
