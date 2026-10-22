import { boundedProcessEnvironment } from '@ai-usage/local-machine/bounded-process';
import {
  boundReviewExcerpt,
  buildReviewPrompt,
  parseClaudeStreamJsonLine,
  REVIEW_ATTEMPT_RUN_LIMITS,
  REVIEW_READ_ONLY_TOOLS,
  type ReviewAttemptResultKind,
  type ReviewAttemptScope,
  type ReviewHarnessGuarantee,
} from '@ai-usage/report-core/work-attempts';
import { CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY, ClaudeCommandError, claudeCommandFor } from './claude-command';
import { ClaudeCliQualificationError, observeManagedSettings, qualifyClaudeCli } from './claude-review-cli';
import { type PrepareReviewScopeOptions, prepareReviewScope, ReviewScopeError } from './claude-review-scope';

/**
 * Launches one read-only Claude Code review (ADR 0053, 0055) and reads its `stream-json` output
 * line by line. This is the only place the product starts a harness, and it is deliberately narrow:
 *
 * - the CLI is qualified first (`--version`, and `--help` must name every control below);
 * - the scope is one commit, prepared with git on this side and carried in the prompt as a
 *   bounded patch (`claude-review-scope.ts`); the agent never needs a shell to see the change;
 * - `claude -p <prompt> --output-format stream-json --verbose --session-id <id>
 *   --setting-sources "" --safe-mode --tools Read Grep Glob --strict-mcp-config
 *   --permission-mode plan`, with every writing, network, delegating (Agent, Task), planning
 *   (TodoWrite) and skill tool also disallowed, a turn cap, and the declared model and effort when
 *   the operator declared them. No settings file (user, project, local) is loaded, so none of their
 *   hooks runs; managed policy cannot be excluded and is declared. No bypass flag, no API fallback.
 * - No shell; `cwd` is the admitted checkout; the environment is the bounded allow-list of the
 *   shared runner (PATH, HOME, locale, XDG) plus `CLAUDE_CONFIG_DIR` when the operator set it, so
 *   the operator's own Claude Code sign-in is used and no credential is ever read or stored here.
 * - stdout is read incrementally with a total byte cap; stderr is discarded; a deadline sends
 *   SIGTERM then SIGKILL. Only the `system/init` and `result` messages are retained, bounded;
 *   the transcript itself is never kept.
 *
 * "Read-only" means no repository write and no external action by the review's tools. The
 * harness still writes its own session logs under the operator's Claude directory, and no OS
 * sandbox is claimed.
 *
 * The executable and its `CLAUDE_CONFIG_DIR` come from `claudeCommandFor` (`./claude-command`),
 * the resolution the executor probe uses too, so the account confirmed is the account launched.
 */
export { CLAUDE_EXECUTABLE_ENVIRONMENT_KEY } from './claude-command';

const TERMINATE_GRACE_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const CLAUDE_REVIEW_ALLOWED_TOOLS = REVIEW_READ_ONLY_TOOLS;
/** Setting sources the launch loads: none. `--setting-sources` takes the empty list as `""`. */
export const CLAUDE_REVIEW_SETTING_SOURCES: ReviewHarnessGuarantee['settingSources'] = [];
export const CLAUDE_REVIEW_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TodoWrite',
  'Skill',
] as const;

export type ClaudeReviewLaunchFailureKind =
  | 'cli-unqualified'
  | 'executable-invalid'
  | 'executable-missing'
  | 'scope-unavailable'
  | 'spawn-failed';

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
  /** The UUID the engine recorded before the spawn; passed as `--session-id`, the process's marker. */
  readonly launchSessionId: string;
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
  /** Managed settings locations to look at; defaults to the platform's documented ones. */
  readonly managedSettingsPaths?: readonly string[];
  /** Forwarded to the scope preparation (limits, test seams). */
  readonly scope?: Omit<PrepareReviewScopeOptions, 'env'>;
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
  /** What the launched session was configured with, as qualified before the spawn. */
  readonly guarantee: ReviewHarnessGuarantee;
  readonly outcome: Promise<ClaudeReviewOutcome>;
  readonly pid: number;
  readonly prompt: string;
  /** The commit and the patch prefix the prompt carries. */
  readonly scope: ReviewAttemptScope;
  /** Asks the process to stop (SIGTERM, then SIGKILL after the grace period); the outcome still settles. */
  readonly terminate: () => void;
}

/** The exact argument vector, exported so tests and the ADR can state it. */
export const claudeReviewArguments = (
  spec: Pick<ClaudeReviewLaunchSpec, 'effort' | 'launchSessionId' | 'maxTurns' | 'model'>,
  prompt: string,
): string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  // The marker the engine looks for in the process table when it loses contact (ADR 0055).
  '--session-id',
  spec.launchSessionId,
  // No settings file at all: user, project and local settings, and the hooks they declare, stay unloaded.
  '--setting-sources',
  CLAUDE_REVIEW_SETTING_SOURCES.join(','),
  // Plugins, skills, CLAUDE.md, hooks and MCP servers from any customization are off.
  '--safe-mode',
  // The only built-in tools the session has; everything below is refused on top.
  '--tools',
  ...CLAUDE_REVIEW_ALLOWED_TOOLS,
  // No MCP server from user, project or local settings: only `--mcp-config` would add one, and none is passed.
  '--strict-mcp-config',
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

/**
 * A spawn error by its class and code only. The runtime's own message quotes the offending
 * argument, which is the prompt (commit SHAs, subject, session title); a stored failure reason
 * must never carry it.
 */
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/u;

export const spawnFailureDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code = 'code' in error && typeof error.code === 'string' && ERROR_CODE.test(error.code) ? error.code : null;
  return code === null ? error.name : `${error.name} ${code}`;
};

/** The shared command and environment (`claudeCommandFor`), with the command made absolute for the spawn. */
const resolveLaunch = (
  options: ClaudeReviewLaunchOptions,
  env: Readonly<Record<string, string | undefined>>,
): { readonly environment: Record<string, string>; readonly executable: string } => {
  let claude: ReturnType<typeof claudeCommandFor>;
  try {
    claude = claudeCommandFor(env, options.executable);
  } catch (error) {
    if (error instanceof ClaudeCommandError) {
      throw new ClaudeReviewLaunchError('executable-invalid', error.message);
    }
    throw error;
  }
  const environment = boundedProcessEnvironment(claude.environment, env);
  if (claude.command.includes('/')) {
    return { environment, executable: claude.command };
  }
  const resolved = Bun.which(claude.command, { PATH: environment.PATH ?? '' });
  if (resolved === null) {
    throw new ClaudeReviewLaunchError('executable-missing', `${claude.command} was not found on the allow-listed PATH`);
  }
  return { environment, executable: resolved };
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
  const { environment, executable } = resolveLaunch(options, env);
  if (!UUID.test(spec.launchSessionId)) {
    throw new ClaudeReviewLaunchError('spawn-failed', 'the launch session id must be a lowercase UUID');
  }
  const configDirectory = environment[CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY];
  let cliVersion: string;
  try {
    ({ version: cliVersion } = await qualifyClaudeCli(executable, {
      environment: configDirectory === undefined ? {} : { [CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY]: configDirectory },
      extraFlags: [...(spec.model === null ? [] : ['--model']), ...(spec.effort === null ? [] : ['--effort'])],
    }));
  } catch (error) {
    if (error instanceof ClaudeCliQualificationError) {
      throw new ClaudeReviewLaunchError('cli-unqualified', error.message);
    }
    throw error;
  }
  let prepared: Awaited<ReturnType<typeof prepareReviewScope>>;
  try {
    prepared = await prepareReviewScope(spec.checkoutPath, { ...options.scope, env });
  } catch (error) {
    if (error instanceof ReviewScopeError) {
      throw new ClaudeReviewLaunchError('scope-unavailable', error.message);
    }
    throw error;
  }
  const guarantee: ReviewHarnessGuarantee = {
    cliVersion,
    effort: spec.effort,
    managedSettings: await observeManagedSettings(options.managedSettingsPaths),
    model: spec.model,
    safeMode: true,
    settingSources: [...CLAUDE_REVIEW_SETTING_SOURCES],
    tools: [...CLAUDE_REVIEW_ALLOWED_TOOLS],
  };
  const prompt = buildReviewPrompt({ patch: prepared.patch, scope: prepared.scope, sessionTitle: spec.sessionTitle });
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
      `claude could not be started in the checkout: ${spawnFailureDetail(error)}`,
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

  return { args, guarantee, outcome, pid: child.pid, prompt, scope: prepared.scope, terminate };
};
