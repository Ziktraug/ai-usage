import { boundedProcessEnvironment, executeBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import {
  boundReviewExcerpt,
  buildReviewPrompt,
  parseClaudeStreamJsonLine,
  REVIEW_ATTEMPT_BOUNDS,
  REVIEW_ATTEMPT_RUN_LIMITS,
  type ReviewAttemptResultKind,
} from '@ai-usage/report-core/work-attempts';

/**
 * Launches one read-only Claude Code review (ADR 0053) and reads its `stream-json` output line by
 * line. This is the only place the product starts a harness, and it is deliberately narrow:
 *
 * - `claude -p <prompt> --output-format stream-json --verbose --permission-mode plan`, with the
 *   read-only tools allowed and every writing or network tool disallowed, a turn cap, and the
 *   declared model and effort when the operator declared them. No bypass flag, no API fallback.
 * - No shell; `cwd` is the admitted checkout; the environment is the bounded allow-list of the
 *   shared runner (PATH, HOME, locale, XDG) plus `CLAUDE_CONFIG_DIR` when the operator set it, so
 *   the operator's own Claude Code sign-in is used and no credential is ever read or stored here.
 * - stdout is read incrementally with a total byte cap; stderr is discarded; a deadline sends
 *   SIGTERM then SIGKILL. Only the `system/init` and `result` messages are retained, bounded;
 *   the transcript itself is never kept.
 *
 * The executable is `claude` on the allow-listed PATH, or the one named by
 * `AI_USAGE_CLAUDE_EXECUTABLE` (an absolute path or a bare name); fixtures use it to substitute a
 * fake harness without touching the operator's PATH.
 */
export const CLAUDE_EXECUTABLE_ENVIRONMENT_KEY = 'AI_USAGE_CLAUDE_EXECUTABLE';
const CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY = 'CLAUDE_CONFIG_DIR';
const TERMINATE_GRACE_MS = 5000;
const GIT_SUMMARY_TIMEOUT_MS = 5000;

export const CLAUDE_REVIEW_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export const CLAUDE_REVIEW_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
] as const;

export type ClaudeReviewLaunchFailureKind = 'executable-missing' | 'spawn-failed';

export class ClaudeReviewLaunchError extends Error {
  readonly kind: ClaudeReviewLaunchFailureKind;

  constructor(kind: ClaudeReviewLaunchFailureKind, message: string) {
    super(message);
    this.name = 'ClaudeReviewLaunchError';
    this.kind = kind;
  }
}

export interface ClaudeReviewLaunchSpec {
  readonly checkoutPath: string;
  readonly effort: string | null;
  readonly heartbeatMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxTurns?: number;
  readonly model: string | null;
  readonly sessionTitle: string | null;
  readonly timeoutMs?: number;
}

export interface ClaudeReviewLaunchEvents {
  /** Fired every `heartbeatMs` while the process lives; the engine stamps `updated_at` with it. */
  readonly onHeartbeat?: () => Promise<void> | void;
  /** Fired once, with the harness's own session id from `system/init`. */
  readonly onInit?: (nativeSessionId: string) => Promise<void> | void;
}

export interface ClaudeReviewLaunchOptions {
  /** Source environment; defaults to `process.env`. Only the allow-listed names reach the child. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
}

export interface ClaudeReviewOutcome {
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  readonly kind: 'failed' | 'finished';
  readonly nativeSessionId: string | null;
  readonly numTurns: number | null;
  readonly resultExcerpt: string | null;
  readonly resultKind: ReviewAttemptResultKind | null;
}

export interface ClaudeReviewLaunch {
  readonly args: readonly string[];
  readonly outcome: Promise<ClaudeReviewOutcome>;
  readonly pid: number;
  readonly prompt: string;
  /** Asks the process to stop (SIGTERM, then SIGKILL after the grace period); the outcome still settles. */
  readonly terminate: () => void;
}

export interface CheckoutSummary {
  readonly gitDiffStat: string | null;
  readonly gitLog: string | null;
}

/** The exact argument vector, exported so tests and the ADR can state it. */
export const claudeReviewArguments = (
  spec: Pick<ClaudeReviewLaunchSpec, 'effort' | 'maxTurns' | 'model'>,
  prompt: string,
): string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'plan',
  '--allowedTools',
  ...CLAUDE_REVIEW_ALLOWED_TOOLS,
  '--disallowedTools',
  ...CLAUDE_REVIEW_DISALLOWED_TOOLS,
  '--max-turns',
  String(spec.maxTurns ?? REVIEW_ATTEMPT_RUN_LIMITS.maxTurns),
  ...(spec.model === null ? [] : ['--model', spec.model]),
  ...(spec.effort === null ? [] : ['--effort', spec.effort]),
];

const gitRead = async (
  checkoutPath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string | null> => {
  try {
    const result = await executeBoundedProcess({
      args,
      command: 'git',
      cwd: checkoutPath,
      env: environment,
      maximumOutputBytes: REVIEW_ATTEMPT_BOUNDS.maxPromptContext,
      timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
};

/** Two bounded, read-only git summaries for the prompt; a checkout git cannot read yields `null`s. */
export const readCheckoutSummary = async (
  checkoutPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CheckoutSummary> => {
  const environment = { ...boundedProcessEnvironment({}, env), GIT_TERMINAL_PROMPT: '0' };
  const gitLog = await gitRead(checkoutPath, ['log', '-1', '--format=%h %s'], environment);
  const gitDiffStat =
    gitLog === null ? null : await gitRead(checkoutPath, ['diff', '--stat', 'HEAD~1..HEAD'], environment);
  return { gitDiffStat, gitLog };
};

const launcherEnvironment = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const configDirectory = env[CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY];
  return boundedProcessEnvironment(
    configDirectory === undefined || configDirectory === ''
      ? {}
      : { [CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY]: configDirectory },
    env,
  );
};

const resolveExecutable = (
  options: ClaudeReviewLaunchOptions,
  env: Readonly<Record<string, string | undefined>>,
  environment: Readonly<Record<string, string>>,
): string => {
  const named = options.executable ?? env[CLAUDE_EXECUTABLE_ENVIRONMENT_KEY] ?? 'claude';
  if (named.includes('/')) {
    return named;
  }
  const resolved = Bun.which(named, { PATH: environment.PATH ?? '' });
  if (resolved === null) {
    throw new ClaudeReviewLaunchError('executable-missing', `${named} was not found on the allow-listed PATH`);
  }
  return resolved;
};

interface StreamReadState {
  durationMs: number | null;
  isError: boolean;
  nativeSessionId: string | null;
  numTurns: number | null;
  resultSeen: boolean;
  resultSubtype: string | null;
  text: string | null;
}

export const launchClaudeReview = async (
  spec: ClaudeReviewLaunchSpec,
  events: ClaudeReviewLaunchEvents = {},
  options: ClaudeReviewLaunchOptions = {},
): Promise<ClaudeReviewLaunch> => {
  const env = options.env ?? process.env;
  const environment = launcherEnvironment(env);
  const executable = resolveExecutable(options, env, environment);
  const summary = await readCheckoutSummary(spec.checkoutPath, env);
  const prompt = buildReviewPrompt({ ...summary, sessionTitle: spec.sessionTitle });
  const args = claudeReviewArguments(spec, prompt);
  const timeoutMs = spec.timeoutMs ?? REVIEW_ATTEMPT_RUN_LIMITS.timeoutMs;
  const heartbeatMs = spec.heartbeatMs ?? REVIEW_ATTEMPT_RUN_LIMITS.heartbeatMs;
  const maxOutputBytes = spec.maxOutputBytes ?? REVIEW_ATTEMPT_RUN_LIMITS.maxOutputBytes;

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
      cwd: spec.checkoutPath,
      env: environment,
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'pipe',
    });
  } catch (error) {
    throw new ClaudeReviewLaunchError(
      'spawn-failed',
      `claude could not be started in the checkout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const startedAt = performance.now();
  let timedOut = false;
  let overflow = false;
  let terminated = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, TERMINATE_GRACE_MS);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const heartbeat = setInterval(() => {
    Promise.resolve(events.onHeartbeat?.()).catch(() => undefined);
  }, heartbeatMs);

  const outcome = (async (): Promise<ClaudeReviewOutcome> => {
    const state: StreamReadState = {
      durationMs: null,
      isError: false,
      nativeSessionId: null,
      numTurns: null,
      resultSeen: false,
      resultSubtype: null,
      text: null,
    };
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    const consumeLine = async (line: string): Promise<void> => {
      const event = parseClaudeStreamJsonLine(line);
      if (event === null) {
        return;
      }
      if (event.kind === 'init') {
        if (state.nativeSessionId === null) {
          state.nativeSessionId = event.sessionId;
          await Promise.resolve(events.onInit?.(event.sessionId)).catch(() => undefined);
        }
        return;
      }
      state.resultSeen = true;
      state.isError = event.isError;
      state.numTurns = event.numTurns;
      state.durationMs = event.durationMs;
      state.resultSubtype = event.subtype;
      state.text = event.text;
      state.nativeSessionId ??= event.sessionId;
    };
    try {
      const stdout = child.stdout;
      if (stdout instanceof ReadableStream) {
        for await (const chunk of stdout) {
          bytes += chunk.byteLength;
          if (bytes > maxOutputBytes) {
            overflow = true;
            child.kill('SIGKILL');
            break;
          }
          pending += decoder.decode(chunk, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            await consumeLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf('\n');
          }
        }
        if (!overflow && pending.length > 0) {
          await consumeLine(pending);
        }
      }
    } catch {
      // A broken pipe after the process died is settled below by the exit code.
    }
    const exitCode = await child.exited;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    const wallMs = Math.max(0, Math.round(performance.now() - startedAt));
    const base = {
      durationMs: state.durationMs ?? wallMs,
      exitCode,
      nativeSessionId: state.nativeSessionId,
      numTurns: state.numTurns,
      resultExcerpt: boundReviewExcerpt(state.text),
    };
    if (timedOut) {
      return {
        ...base,
        failureReason: `timed out after ${Math.round(timeoutMs / 1000)} s; the process was terminated`,
        kind: 'failed',
        resultKind: 'timeout',
      };
    }
    if (overflow) {
      return {
        ...base,
        failureReason: `stdout exceeded ${maxOutputBytes} bytes; the process was terminated`,
        kind: 'failed',
        resultKind: 'error',
      };
    }
    if (terminated) {
      return { ...base, failureReason: 'terminated by the engine', kind: 'failed', resultKind: 'error' };
    }
    if (!state.resultSeen) {
      return {
        ...base,
        failureReason: `exit ${exitCode} without a result message`,
        kind: 'failed',
        resultKind: 'error',
      };
    }
    if (state.isError) {
      return {
        ...base,
        failureReason: `the harness reported an error result${state.resultSubtype ? ` (${state.resultSubtype})` : ''}`,
        kind: 'failed',
        resultKind: 'error',
      };
    }
    if (exitCode !== 0) {
      return { ...base, failureReason: `exit ${exitCode} after a result`, kind: 'failed', resultKind: 'error' };
    }
    return { ...base, failureReason: null, kind: 'finished', resultKind: 'review' };
  })();

  return { args, outcome, pid: child.pid, prompt, terminate };
};
