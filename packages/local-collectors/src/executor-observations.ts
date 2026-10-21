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
 * and does its own non-interactive status command say it is signed in. Metadata only: nothing here
 * opens a session, generates text, or reads a credential file. Evidence strings are built from exit
 * codes and a classification word, never from raw output, so an email or token on stdout can never
 * reach the store.
 *
 * Process execution is injected. The default `runBoundedProcess` is a minimal Bun.spawn runner
 * (no shell, stderr discarded, timeout then kill); the integrator replaces it with the shared
 * bounded runner when that lands.
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

export type BoundedProcessFailureKind = 'output-limit' | 'spawn-failed' | 'timeout';

export class BoundedProcessError extends Error {
  readonly kind: BoundedProcessFailureKind;

  constructor(kind: BoundedProcessFailureKind, command: string) {
    super(`${command}: ${kind}`);
    this.name = 'BoundedProcessError';
    this.kind = kind;
  }
}

export const runBoundedProcess: BoundedRun = async (spec) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([spec.command, ...spec.args], {
      env: { ...process.env, ...spec.env },
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'pipe',
    });
  } catch {
    throw new BoundedProcessError('spawn-failed', spec.command);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, spec.timeoutMs);
  try {
    const stdout = child.stdout;
    if (!(stdout instanceof ReadableStream)) {
      throw new BoundedProcessError('spawn-failed', spec.command);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let overflow = false;
    for await (const chunk of stdout) {
      bytes += chunk.byteLength;
      if (bytes > spec.maximumOutputBytes) {
        overflow = true;
        child.kill('SIGKILL');
        break;
      }
      chunks.push(chunk);
    }
    const exitCode = await child.exited;
    if (timedOut) {
      throw new BoundedProcessError('timeout', spec.command);
    }
    if (overflow) {
      throw new BoundedProcessError('output-limit', spec.command);
    }
    return { exitCode, stdout: new TextDecoder().decode(Buffer.concat(chunks, bytes)) };
  } finally {
    clearTimeout(timer);
  }
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

const EXECUTOR_COMMANDS: Readonly<Record<ExecutorHarness, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

interface AuthProbe {
  readonly authState: ExecutorAuthState;
  readonly evidence: string;
  readonly outcome: ExecutorObservationOutcome;
}

const bounded = (text: string): string => text.slice(0, EXECUTOR_BOUNDS.maxText);

const versionFrom = (stdout: string): string | null => {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line && VERSION_PATTERN.test(line) ? bounded(line) : null;
};

const failureKind = (error: unknown): BoundedProcessFailureKind =>
  error instanceof BoundedProcessError ? error.kind : 'spawn-failed';

/** `claude auth status` prints JSON by default; only its `loggedIn` boolean is read. */
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
    const kind = failureKind(error);
    return {
      authState: 'unknown',
      evidence: `claude auth status ${kind}`,
      outcome: kind === 'timeout' ? 'timeout' : 'invalid',
    };
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
      authState: 'unknown',
      evidence:
        result.exitCode === 0
          ? 'claude auth status exit 0 without a loggedIn field'
          : `no non-interactive auth status command (claude auth status exit ${result.exitCode})`,
      outcome: 'observed',
    };
  }
  const authMethod =
    typeof payload === 'object' && payload !== null && 'authMethod' in payload && typeof payload.authMethod === 'string'
      ? ` authMethod=${bounded(payload.authMethod).slice(0, 32)}`
      : '';
  return {
    authState: loggedIn ? 'logged-in' : 'logged-out',
    evidence: `claude auth status exit ${result.exitCode} loggedIn=${loggedIn}${authMethod}`,
    outcome: 'observed',
  };
};

/**
 * `codex login status`: the exit code is the contract (0 signed in, non-zero not). The CLI writes
 * its "Logged in using …" line to stderr, which the bounded runner discards, so a stdout mention is
 * recorded as extra evidence when present but never required.
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
    const kind = failureKind(error);
    return {
      authState: 'unknown',
      evidence: `codex login status ${kind}`,
      outcome: kind === 'timeout' ? 'timeout' : 'invalid',
    };
  }
  if (result.exitCode !== 0) {
    return { authState: 'logged-out', evidence: `codex login status exit ${result.exitCode}`, outcome: 'observed' };
  }
  const mentionsLoggedIn = CODEX_LOGGED_IN_PATTERN.test(result.stdout);
  return {
    authState: 'logged-in',
    evidence: mentionsLoggedIn
      ? 'codex login status exit 0 (output mentions "Logged in")'
      : 'codex login status exit 0',
    outcome: 'observed',
  };
};

const observeExecutor = async (
  harness: ExecutorHarness,
  input: Required<Pick<ObserveExecutorsInput, 'machineId' | 'now' | 'run' | 'timeoutMs' | 'which'>>,
): Promise<ExecutorObservation> => {
  const command = EXECUTOR_COMMANDS[harness];
  const observedAt = input.now().toISOString();
  const binaryPath = input.which(command);
  const base = { harness, machineId: input.machineId, observedAt };
  if (binaryPath === null) {
    return {
      ...base,
      authEvidence: `${command} binary not found on PATH`,
      authState: 'unknown',
      binaryPath: null,
      outcome: 'unavailable',
      version: null,
    };
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
    versionOutcome = kind === 'timeout' ? 'timeout' : 'invalid';
    versionEvidence = `${command} --version ${kind}`;
  }
  const auth =
    harness === 'claude-code'
      ? await claudeAuthProbe(input.run, input.timeoutMs)
      : await codexAuthProbe(input.run, input.timeoutMs);
  const outcome: ExecutorObservationOutcome = versionOutcome === 'observed' ? auth.outcome : versionOutcome;
  const evidence = versionEvidence === '' ? auth.evidence : `${versionEvidence}; ${auth.evidence}`;
  return {
    ...base,
    authEvidence: bounded(evidence),
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
