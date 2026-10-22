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
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maximumOutputBytes: number;
  readonly timeoutMs: number;
}

export interface BoundedRunResult {
  readonly exitCode: number;
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
    ...(spec.env === undefined ? {} : { env: spec.env }),
  });
  return { exitCode: result.exitCode, stdout: result.stdout };
};

export interface ObserveExecutorsInput {
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
const CODEX_API_KEY_PATTERN = /api key/iu;
const CODEX_CHATGPT_PATTERN = /chatgpt/iu;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/u;

const EXECUTOR_COMMANDS: Readonly<Record<ExecutorHarness, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

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
const claudeAuthProbe = async (run: BoundedRun, timeoutMs: number): Promise<AuthProbe> => {
  let result: BoundedRunResult;
  try {
    result = await run({
      args: ['auth', 'status'],
      command: 'claude',
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
 * its "Logged in using …" line to stderr, which the bounded runner discards, so a stdout mention is
 * recorded as extra evidence (and as the sign-in method) when present but never required.
 */
const codexAuthProbe = async (run: BoundedRun, timeoutMs: number): Promise<AuthProbe> => {
  let result: BoundedRunResult;
  try {
    result = await run({
      args: ['login', 'status'],
      command: 'codex',
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
  let authMethod: string | null = null;
  if (CODEX_API_KEY_PATTERN.test(result.stdout)) {
    authMethod = 'api-key';
  } else if (CODEX_CHATGPT_PATTERN.test(result.stdout)) {
    authMethod = 'chatgpt';
  }
  // Codex names its account only inside its credential file, which is never read: no fingerprint.
  return {
    accountFingerprint: null,
    authMethod,
    authState: 'logged-in',
    evidence: mentionsLoggedIn
      ? 'codex login status exit 0 (output mentions "Logged in")'
      : 'codex login status exit 0',
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

const observeExecutor = async (
  harness: ExecutorHarness,
  input: Required<Pick<ObserveExecutorsInput, 'machineId' | 'now' | 'run' | 'timeoutMs' | 'which'>>,
): Promise<ExecutorObservation> => {
  const command = EXECUTOR_COMMANDS[harness];
  const observedAt = input.now().toISOString();
  const binaryPath = input.which(command);
  const base: ObservationBase = { harness, machineId: input.machineId, observedAt };
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
    harness === 'claude-code'
      ? await claudeAuthProbe(input.run, input.timeoutMs)
      : await codexAuthProbe(input.run, input.timeoutMs);
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

export const observeExecutors = async (input: ObserveExecutorsInput): Promise<ExecutorObservation[]> => {
  const resolved = {
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
