import { spawn } from 'node:child_process';
import { Data, Effect } from 'effect';

/**
 * The one way this repository runs a local executable for its own reads (`git`, `gh`):
 *
 * - no shell, so arguments are never re-parsed;
 * - an explicit environment: nothing from `process.env` reaches the child except the
 *   allow-listed locale and path variables below, plus what the caller passes by name;
 * - a deadline and an output ceiling, both enforced with SIGKILL;
 * - stderr drained and never retained, logged or returned: provider diagnostics can carry
 *   tokens, paths and prose. A caller that must read one fact a CLI prints only there (`codex
 *   login status` names its sign-in method on stderr) passes `classifyStderr`: at most
 *   `BOUNDED_PROCESS_STDERR_CLASSIFICATION_BYTES` are held in memory, handed once to the
 *   classifier, and dropped; only the classifier's closed-vocabulary answer is returned;
 * - stdout decoded as UTF-8 with fatal errors, so a binary or truncated stream is a failure
 *   rather than mojibake in a durable row.
 *
 * A process that ran to completion is a result whatever its exit code; mapping the code is the
 * caller's knowledge (`git status` exits 128 outside a repository, `gh` exits 4 without
 * credentials). The error vocabulary is closed to what the runner itself can know.
 */
export type BoundedProcessFailureKind = 'failed' | 'output-limit' | 'timed-out' | 'unavailable';

/** Why a process `failed`: killed by a signal this runner did not send, or stdout not UTF-8. */
export type BoundedProcessFailedCause = 'signalled' | 'undecodable';

export class BoundedProcessError extends Data.TaggedError('BoundedProcessError')<{
  /** Set for `failed` only. */
  readonly failure?: BoundedProcessFailedCause;
  readonly kind: BoundedProcessFailureKind;
  readonly message: string;
}> {}

const boundedProcessError = (kind: BoundedProcessFailureKind): BoundedProcessError =>
  new BoundedProcessError({ kind, message: `Bounded process ${kind}` });

const failedProcess = (failure: BoundedProcessFailedCause): BoundedProcessError =>
  new BoundedProcessError({ failure, kind: 'failed', message: `Bounded process failed (${failure})` });

export interface BoundedProcessOptions {
  readonly args: readonly string[];
  /**
   * Reads one closed-vocabulary fact from stderr, which is otherwise never inspected. The text is
   * bounded, passed once, and dropped; return a word of your own vocabulary or `null`, never the text.
   */
  readonly classifyStderr?: (stderr: string) => string | null;
  /** A bare name resolved on the allow-listed PATH, or an absolute path. */
  readonly command: string;
  readonly cwd?: string;
  /**
   * Variables passed by name on top of the inherited allow-list. The caller names each one
   * (`GH_TOKEN` for one call, `GIT_TERMINAL_PROMPT`); nothing else from the parent leaks in.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface BoundedProcessResult {
  readonly durationMs: number;
  readonly exitCode: number;
  /** The `classifyStderr` answer; absent when no classifier was passed, `null` when it named nothing. */
  readonly stderrClass?: string | null;
  readonly stdout: string;
}

export type BoundedProcessRunner = (
  options: BoundedProcessOptions,
) => Effect.Effect<BoundedProcessResult, BoundedProcessError>;

/** Exact names the child may inherit from this process. */
export const BOUNDED_PROCESS_INHERITED_VARIABLES: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'];
/** Prefixes the child may inherit: the XDG base directories locate `gh` and `git` configuration. */
export const BOUNDED_PROCESS_INHERITED_PREFIXES: readonly string[] = ['XDG_'];
/** The most stderr a `classifyStderr` caller may see; beyond it the classifier receives nothing. */
export const BOUNDED_PROCESS_STDERR_CLASSIFICATION_BYTES = 4096;

/**
 * The environment handed to a child: the allow-listed subset of `source`, then the caller's
 * explicit variables. Exported so callers and tests can see exactly what a process receives.
 */
export const boundedProcessEnvironment = (
  explicit: Readonly<Record<string, string>> = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === '') {
      continue;
    }
    if (
      BOUNDED_PROCESS_INHERITED_VARIABLES.includes(name) ||
      BOUNDED_PROCESS_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, ...explicit };
};

const abortError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError');

/**
 * Promise form, for callers that live outside Effect. Rejects with a `BoundedProcessError`, or
 * with the abort reason when `signal` fires first. Never rejects with anything else: a spawn
 * failure is `unavailable`, an undecodable stream is `failed`.
 */
export const executeBoundedProcess = async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
  options.signal?.throwIfAborted();
  const environment = boundedProcessEnvironment(options.env);
  if (Bun.which(options.command, { PATH: environment.PATH ?? '' }) === null) {
    throw boundedProcessError('unavailable');
  }
  return await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(options.command, [...options.args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: BoundedProcessError | null = null;
    let aborted: Error | null = null;
    let settled = false;
    const abort = (): void => {
      aborted = abortError(options.signal?.reason);
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => {
      failure = boundedProcessError('timed-out');
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const finish = (outcome: BoundedProcessResult | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (outcome instanceof Error) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > options.maximumOutputBytes) {
        failure ??= boundedProcessError('output-limit');
        child.kill('SIGKILL');
        return;
      }
      chunks.push(buffer);
    });
    // Drained so the child never blocks on a full pipe; never retained, inspected or logged,
    // except the bounded prefix a caller's classifier reads once on close.
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (options.classifyStderr === undefined) {
        return;
      }
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stderrBytes += buffer.byteLength;
      if (stderrBytes <= BOUNDED_PROCESS_STDERR_CLASSIFICATION_BYTES) {
        stderrChunks.push(buffer);
      }
    });
    const classifiedStderr = (): { readonly stderrClass?: string | null } => {
      if (options.classifyStderr === undefined) {
        return {};
      }
      if (stderrBytes > BOUNDED_PROCESS_STDERR_CLASSIFICATION_BYTES) {
        return { stderrClass: null };
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(stderrChunks));
      stderrChunks.length = 0;
      return { stderrClass: options.classifyStderr(text) };
    };
    child.once('error', () => finish(boundedProcessError('unavailable')));
    child.once('close', (code) => {
      if (aborted !== null) {
        finish(aborted);
      } else if (failure !== null) {
        finish(failure);
      } else if (code === null) {
        // Terminated by a signal this runner did not send.
        finish(failedProcess('signalled'));
      } else {
        try {
          finish({
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            exitCode: code,
            ...classifiedStderr(),
            stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
          });
        } catch {
          finish(failedProcess('undecodable'));
        }
      }
    });
  });
};

/**
 * Effect form. Fiber interruption and an external `signal` both kill the child and interrupt
 * the effect; the typed failures are the runner's own vocabulary only.
 */
export const runBoundedProcess: BoundedProcessRunner = (options) =>
  Effect.callback<BoundedProcessResult, BoundedProcessError>((resume) => {
    const controller = new AbortController();
    const forward = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forward, { once: true });
    if (options.signal?.aborted) {
      forward();
    }
    executeBoundedProcess({ ...options, signal: controller.signal }).then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) => {
        if (error instanceof BoundedProcessError) {
          resume(Effect.fail(error));
        } else if (controller.signal.aborted) {
          resume(Effect.interrupt);
        } else {
          resume(Effect.die(error));
        }
      },
    );
    return Effect.sync(() => {
      options.signal?.removeEventListener('abort', forward);
      controller.abort();
    });
  });
