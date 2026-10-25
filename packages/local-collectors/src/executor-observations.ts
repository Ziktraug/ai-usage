import { createHash } from 'node:crypto';
import {
  BoundedProcessError,
  type BoundedProcessFailureKind,
  executeBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import {
  EXECUTOR_BOUNDS,
  EXECUTOR_HARNESSES,
  type ExecutorAuthState,
  type ExecutorHarness,
  type ExecutorObservation,
  type ExecutorObservationOutcome,
  parseExecutorObservation,
} from '@ai-usage/report-core/work-executors';
import { type ClaudeCommand, ClaudeCommandError, claudeCommandFor } from './claude-command';
import { type CodexCommand, codexCommandFor } from './codex-review-worker';

/**
 * Observes the review executors a machine could run: is the harness CLI on the PATH, which version,
 * does its own non-interactive status command say it is signed in, through which method, and to
 * which account (as a truncated hash, ADR 0057). Metadata only: nothing here opens a session,
 * generates text, or reads a credential file. Evidence strings are built from exit codes and a
 * classification word, never from raw output, so an email or token on stdout can never reach the
 * store.
 *
 * Process execution goes through the repository's one bounded runner
 * (`@ai-usage/local-machine/bounded-process`): no shell, an allow-listed environment (PATH, HOME,
 * locale and XDG variables only), a deadline and an output ceiling, stderr drained and discarded.
 * The runner is injectable for tests; the seam speaks the runner's own typed failures.
 */
export interface BoundedRunSpec {
  readonly args: readonly string[];
  /** Forwarded to the shared runner: one closed-vocabulary read of stderr, the text dropped. */
  readonly classifyStderr?: (stderr: string) => string | null;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  readonly timeoutMs: number;
}

export interface BoundedRunResult {
  readonly exitCode: number;
  /** The `classifyStderr` answer, when one was asked for. */
  readonly stderrClass?: string | null;
  readonly stdout: string;
}

export type BoundedRun = (spec: BoundedRunSpec) => Promise<BoundedRunResult>;

/** The seam's failure vocabulary is the shared runner's own. */
export { BoundedProcessError, type BoundedProcessFailureKind } from '@ai-usage/local-machine/bounded-process';

/** The default runner: the shared bounded process, so the probes inherit its environment allow-list. */
export const runBoundedProcess: BoundedRun = async (spec) => {
  const result = await executeBoundedProcess({
    args: spec.args,
    command: spec.command,
    maximumOutputBytes: spec.maximumOutputBytes,
    timeoutMs: spec.timeoutMs,
    ...(spec.classifyStderr === undefined ? {} : { classifyStderr: spec.classifyStderr }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
  });
  return {
    exitCode: result.exitCode,
    ...(result.stderrClass === undefined ? {} : { stderrClass: result.stderrClass }),
    stdout: result.stdout,
  };
};

export interface ObserveExecutorsInput {
  /**
   * The environment the review launch uses (default `process.env`): its `CLAUDE_CONFIG_DIR` and
   * `AI_USAGE_CLAUDE_EXECUTABLE` decide which CLI and which account the Claude probe reads, its
   * `CODEX_HOME` and `AI_USAGE_CODEX_EXECUTABLE` the same for Codex. Each probe resolves its command
   * with the launcher's own resolver (`claudeCommandFor`, `codexCommandFor`), so what is observed is
   * the profile a delegation would run with.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly harnesses?: readonly ExecutorHarness[];
  readonly machineId: string;
  readonly now?: () => Date;
  readonly run?: BoundedRun;
  /** Per-command deadline; the two commands per harness run sequentially. */
  readonly timeoutMs?: number;
  readonly which?: (command: string) => string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/u;
const CODEX_LOGGED_IN_PATTERN = /logged in/iu;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/u;

/**
 * The sign-in methods `codex login status` can name ("Logged in using …"), as a closed vocabulary.
 * Any "API key" wording (OpenAI or Amazon Bedrock) is `api-key`, so a declared subscription is
 * contradicted for Codex exactly as for Claude (`executorAuthMethodIndicatesApiKey`). The
 * patterns are tested in order: "personal access token" before "access token".
 */
export const CODEX_AUTH_METHODS = [
  'chatgpt',
  'api-key',
  'access-token',
  'personal-access-token',
  'workload-identity',
  'aws-access-keys',
] as const;
export type CodexAuthMethod = (typeof CODEX_AUTH_METHODS)[number];

const CODEX_AUTH_METHOD_PATTERNS: readonly { readonly method: CodexAuthMethod; readonly pattern: RegExp }[] = [
  { method: 'api-key', pattern: /api key/iu },
  { method: 'personal-access-token', pattern: /personal access token/iu },
  { method: 'access-token', pattern: /access token/iu },
  { method: 'workload-identity', pattern: /workload identity/iu },
  { method: 'aws-access-keys', pattern: /aws access keys/iu },
  { method: 'chatgpt', pattern: /chatgpt/iu },
];

/** The method word for a `codex login status` output; `null` when it names none of the known ones. */
export const classifyCodexAuthMethod = (stdout: string): CodexAuthMethod | null =>
  CODEX_AUTH_METHOD_PATTERNS.find(({ pattern }) => pattern.test(stdout))?.method ?? null;

const isCodexAuthMethod = (value: unknown): value is CodexAuthMethod =>
  typeof value === 'string' && (CODEX_AUTH_METHODS as readonly string[]).includes(value);

/** Narrows a runner classification back to the vocabulary; anything else is no method. */
const codexAuthMethodFrom = (value: string | null | undefined): CodexAuthMethod | null =>
  isCodexAuthMethod(value) ? value : null;

interface AuthProbe {
  readonly accountFingerprint: string | null;
  readonly authMethod: string | null;
  readonly authState: ExecutorAuthState;
  readonly evidence: string;
  readonly outcome: ExecutorObservationOutcome;
}

const bounded = (text: string): string => text.slice(0, EXECUTOR_BOUNDS.maxText);

/** Domain separation: this fingerprint is comparable only with fingerprints made by this function. */
const ACCOUNT_FINGERPRINT_DOMAIN = 'ai-usage executor account v1';
/** An identifier longer than this is not one the CLI reports; it is treated as absent, never truncated. */
const MAX_IDENTIFIER_LENGTH = 512;

const identifier = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTIFIER_LENGTH ? trimmed : null;
};

/**
 * The account `claude auth status` reports (organization id and account email), reduced to the
 * first 16 hexadecimal characters of a domain-separated SHA-256 (ADR 0057). It is comparable
 * between observations and with a pinned declaration; the identifiers themselves are never kept.
 * `null` when the CLI reported neither.
 */
export const claudeAccountFingerprint = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const organization = identifier('orgId' in payload ? payload.orgId : undefined);
  const email = identifier('email' in payload ? payload.email : undefined)?.toLowerCase() ?? null;
  if (organization === null && email === null) {
    return null;
  }
  return createHash('sha256')
    .update(`${ACCOUNT_FINGERPRINT_DOMAIN}\norg=${organization ?? ''}\nemail=${email ?? ''}`)
    .digest('hex')
    .slice(0, EXECUTOR_BOUNDS.accountFingerprintLength);
};

/** A sign-in method as the CLI names it, kept only when it is short printable ASCII. */
const boundedAuthMethod = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const method = value.trim().slice(0, EXECUTOR_BOUNDS.maxAuthMethod);
  return PRINTABLE_ASCII_PATTERN.test(method) ? method : null;
};

const versionFrom = (stdout: string): string | null => {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line && VERSION_PATTERN.test(line) ? bounded(line) : null;
};

const failureKind = (error: unknown): BoundedProcessFailureKind =>
  error instanceof BoundedProcessError ? error.kind : 'failed';

const outcomeOfFailure = (kind: BoundedProcessFailureKind): ExecutorObservationOutcome => {
  if (kind === 'timed-out') {
    return 'timeout';
  }
  return kind === 'unavailable' ? 'unavailable' : 'invalid';
};

const failedProbe = (command: string, kind: BoundedProcessFailureKind): AuthProbe => ({
  accountFingerprint: null,
  authMethod: null,
  authState: 'unknown',
  evidence: `${command} ${kind}`,
  outcome: outcomeOfFailure(kind),
});

/**
 * `claude auth status` prints JSON by default; only its `loggedIn` boolean, its `authMethod` word
 * and, for a signed-in CLI, the hash of its `orgId` and `email` are kept.
 */
const claudeAuthProbe = async (run: BoundedRun, timeoutMs: number, claude: ClaudeCommand): Promise<AuthProbe> => {
  let result: BoundedRunResult;
  try {
    result = await run({
      args: ['auth', 'status'],
      command: claude.command,
      env: claude.environment,
      maximumOutputBytes: MAXIMUM_OUTPUT_BYTES,
      timeoutMs,
    });
  } catch (error) {
    return failedProbe('claude auth status', failureKind(error));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch {
    payload = undefined;
  }
  const loggedIn =
    typeof payload === 'object' && payload !== null && 'loggedIn' in payload && typeof payload.loggedIn === 'boolean'
      ? payload.loggedIn
      : null;
  if (loggedIn === null) {
    // Older CLIs have no `auth status`; they exit non-zero with usage text. That is "unknown",
    // never a reason to read the credentials file instead.
    return {
      accountFingerprint: null,
      authMethod: null,
      authState: 'unknown',
      evidence:
        result.exitCode === 0
          ? 'claude auth status exit 0 without a loggedIn field'
          : `no non-interactive auth status command (claude auth status exit ${result.exitCode})`,
      outcome: 'observed',
    };
  }
  const authMethod =
    typeof payload === 'object' && payload !== null && 'authMethod' in payload
      ? boundedAuthMethod(payload.authMethod)
      : null;
  return {
    accountFingerprint: loggedIn ? claudeAccountFingerprint(payload) : null,
    authMethod,
    authState: loggedIn ? 'logged-in' : 'logged-out',
    evidence: `claude auth status exit ${result.exitCode} loggedIn=${loggedIn}${authMethod === null ? '' : ` authMethod=${authMethod}`}`,
    outcome: 'observed',
  };
};

/**
 * `codex login status`: the exit code is the contract (0 signed in, non-zero not). The CLI writes
 * its "Logged in using …" line to stderr (codex-cli 0.164), so the runner classifies that line into
 * the closed sign-in vocabulary and drops the text; a stdout mention counts the same way. The
 * method is evidence beside the exit code, never required. The command and its `CODEX_HOME` are the
 * launcher's (`codexCommandFor`), so the sign-in read is the one a worker would run with.
 */
const codexAuthProbe = async (run: BoundedRun, timeoutMs: number, codex: CodexCommand): Promise<AuthProbe> => {
  let result: BoundedRunResult;
  try {
    result = await run({
      args: ['login', 'status'],
      classifyStderr: classifyCodexAuthMethod,
      command: codex.command,
      env: codex.environment,
      maximumOutputBytes: MAXIMUM_OUTPUT_BYTES,
      timeoutMs,
    });
  } catch (error) {
    return failedProbe('codex login status', failureKind(error));
  }
  if (result.exitCode !== 0) {
    return {
      accountFingerprint: null,
      authMethod: null,
      authState: 'logged-out',
      evidence: `codex login status exit ${result.exitCode}`,
      outcome: 'observed',
    };
  }
  const mentionsLoggedIn = CODEX_LOGGED_IN_PATTERN.test(result.stdout);
  const authMethod = classifyCodexAuthMethod(result.stdout) ?? codexAuthMethodFrom(result.stderrClass);
  // Codex names its account only inside its credential file, which is never read: no fingerprint.
  return {
    accountFingerprint: null,
    authMethod,
    authState: 'logged-in',
    evidence: `${mentionsLoggedIn ? 'codex login status exit 0 (output mentions "Logged in")' : 'codex login status exit 0'}${authMethod === null ? '' : ` authMethod=${authMethod}`}`,
    outcome: 'observed',
  };
};

type ObservationBase = Pick<ExecutorObservation, 'harness' | 'machineId' | 'observedAt'>;

/** The executor cannot be run here: no binary on the PATH, or the bounded runner could not start it. */
const unavailableObservation = (base: ObservationBase, evidence: string): ExecutorObservation => ({
  ...base,
  authEvidence: bounded(evidence),
  authMethod: null,
  authState: 'unknown',
  binaryPath: null,
  outcome: 'unavailable',
  version: null,
});

type LaunchCommand = Pick<CodexCommand, 'command' | 'environment'>;

/**
 * The harness's command and environment as its launcher resolves them (`claudeCommandFor`,
 * `codexCommandFor`), or the reason it cannot be run: the observation is of the profile a
 * delegation would run with, never of a bare name on the PATH.
 */
const resolveLaunchCommand = (
  harness: ExecutorHarness,
  env: Readonly<Record<string, string | undefined>>,
): { readonly claude: ClaudeCommand | null; readonly launch: LaunchCommand } | { readonly unavailable: string } => {
  if (harness === 'claude-code') {
    try {
      const claude = claudeCommandFor(env);
      return { claude, launch: claude };
    } catch (error) {
      if (error instanceof ClaudeCommandError) {
        return { unavailable: error.message };
      }
      throw error;
    }
  }
  const codex = codexCommandFor(env);
  return 'command' in codex ? { claude: null, launch: codex } : { unavailable: codex.message };
};

const observeExecutor = async (
  harness: ExecutorHarness,
  input: Required<Pick<ObserveExecutorsInput, 'env' | 'machineId' | 'now' | 'run' | 'timeoutMs' | 'which'>>,
): Promise<ExecutorObservation> => {
  const observedAt = input.now().toISOString();
  const base: ObservationBase = { harness, machineId: input.machineId, observedAt };
  const resolved = resolveLaunchCommand(harness, input.env);
  if ('unavailable' in resolved) {
    return unavailableObservation(base, resolved.unavailable);
  }
  const { claude, launch } = resolved;
  const { command, environment } = launch;
  const binaryPath = command.includes('/') ? command : input.which(command);
  if (binaryPath === null) {
    return unavailableObservation(base, `${command} binary not found on PATH`);
  }
  let version: string | null = null;
  let versionOutcome: ExecutorObservationOutcome = 'observed';
  let versionEvidence = '';
  try {
    const result = await input.run({
      args: ['--version'],
      command,
      env: environment,
      maximumOutputBytes: MAXIMUM_OUTPUT_BYTES,
      timeoutMs: input.timeoutMs,
    });
    version = result.exitCode === 0 ? versionFrom(result.stdout) : null;
    if (version === null) {
      versionOutcome = 'invalid';
      versionEvidence = `${command} --version exit ${result.exitCode} without a version`;
    }
  } catch (error) {
    const kind = failureKind(error);
    if (kind === 'unavailable') {
      return unavailableObservation(base, `${command} --version unavailable to the bounded runner`);
    }
    versionOutcome = outcomeOfFailure(kind);
    versionEvidence = `${command} --version ${kind}`;
  }
  const auth =
    claude === null
      ? await codexAuthProbe(input.run, input.timeoutMs, launch)
      : await claudeAuthProbe(input.run, input.timeoutMs, claude);
  if (auth.outcome === 'unavailable') {
    return unavailableObservation(base, `${auth.evidence} to the bounded runner`);
  }
  const outcome: ExecutorObservationOutcome = versionOutcome === 'observed' ? auth.outcome : versionOutcome;
  const evidence = versionEvidence === '' ? auth.evidence : `${versionEvidence}; ${auth.evidence}`;
  return {
    ...base,
    ...(auth.accountFingerprint === null ? {} : { accountFingerprint: auth.accountFingerprint }),
    authEvidence: bounded(evidence),
    authMethod: auth.authMethod,
    authState: auth.authState,
    binaryPath: binaryPath.length <= EXECUTOR_BOUNDS.maxPath ? binaryPath : null,
    outcome,
    version,
  };
};

export interface ClaudeAccountProbe {
  /** The fingerprint of the account the CLI reports now; `null` when it reports none or the probe failed. */
  readonly accountFingerprint: string | null;
  readonly evidence: string;
}

/**
 * Reads the signed-in Claude Code account now, with the launch's own command and environment
 * (`claudeCommandFor`): what a start re-checks against a pinned route (ADR 0057).
 */
export const probeClaudeAccount = async (input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly run?: BoundedRun;
  readonly timeoutMs?: number;
}): Promise<ClaudeAccountProbe> => {
  let claude: ClaudeCommand;
  try {
    claude = claudeCommandFor(input.env ?? process.env, input.executable);
  } catch (error) {
    if (error instanceof ClaudeCommandError) {
      return { accountFingerprint: null, evidence: error.message };
    }
    throw error;
  }
  const auth = await claudeAuthProbe(input.run ?? runBoundedProcess, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, claude);
  return { accountFingerprint: auth.accountFingerprint, evidence: auth.evidence };
};

export interface CodexAuthProbe {
  /** The sign-in method word (`CODEX_AUTH_METHODS`) when the CLI named one; `null` otherwise. */
  readonly authMethod: string | null;
  readonly authState: ExecutorAuthState;
  readonly evidence: string;
  /** `observed` when `codex login status` answered; `unavailable` when the command could not be run at all. */
  readonly outcome: ExecutorObservationOutcome;
}

/**
 * Reads the Codex sign-in now, with the launch's own command and `CODEX_HOME` (`codexCommandFor`):
 * what a start re-checks just before launching a Codex worker, so the profile that bills the run is
 * the one admitted (a subscription, never an API key). Codex names no account, so there is no
 * fingerprint to compare; the state and the method word are the whole evidence.
 */
export const probeCodexAuth = async (input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly run?: BoundedRun;
  readonly timeoutMs?: number;
}): Promise<CodexAuthProbe> => {
  const codex = codexCommandFor(input.env ?? process.env, input.executable);
  if (!('command' in codex)) {
    return { authMethod: null, authState: 'unknown', evidence: codex.message, outcome: 'unavailable' };
  }
  const auth = await codexAuthProbe(input.run ?? runBoundedProcess, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, codex);
  return { authMethod: auth.authMethod, authState: auth.authState, evidence: auth.evidence, outcome: auth.outcome };
};

export const observeExecutors = async (input: ObserveExecutorsInput): Promise<ExecutorObservation[]> => {
  const resolved = {
    env: input.env ?? process.env,
    machineId: input.machineId,
    now: input.now ?? (() => new Date()),
    run: input.run ?? runBoundedProcess,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    which: input.which ?? ((command: string) => Bun.which(command)),
  };
  const observations: ExecutorObservation[] = [];
  for (const harness of input.harnesses ?? EXECUTOR_HARNESSES) {
    const observation = parseExecutorObservation(await observeExecutor(harness, resolved));
    if (observation === null) {
      throw new Error(`Executor observation for ${harness} did not satisfy its own contract`);
    }
    observations.push(observation);
  }
  return observations;
};
