import { lstat, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BoundedProcessError, executeBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import type { DelegationHarnessGuarantee, DelegationUsage } from '@ai-usage/report-core/delegation-contracts';
import { DELEGATION_BOUNDS } from '@ai-usage/report-core/delegation-vocabulary';
import { isPrintableSkillObservationText } from '@ai-usage/report-core/skill-observation';
import { parseClaudeHelpFlags } from './claude-review-cli';
import {
  addUsage,
  boundTextBytes,
  boundWorkerFinalText,
  DELEGATION_HARNESS_CONTROLS,
  delegationLaunchMarkerToken,
  describeProcessStop,
  harnessUsage,
  LAUNCH_MARKER_PATTERN,
  locateExecutable,
  type ReviewWorkerAdapter,
  type ReviewWorkerEvents,
  type ReviewWorkerLaunch,
  ReviewWorkerLaunchError,
  type ReviewWorkerLaunchOptions,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
  workerEnvironment,
} from './review-worker';
import { spawnBoundedJsonlProcess, spawnFailureDetail } from './review-worker-process';

/**
 * The Codex delegation worker: `codex exec` run non-interactively with every per-invocation control
 * the CLI offers for a read-only run (codex-cli 0.164): its own sandbox in `read-only` mode,
 * approvals never asked, user config and execpolicy rules ignored, no MCP server, web search off,
 * hooks and multi-agent off, the prompt on stdin, events as JSONL on stdout, the last message in a
 * private file the engine owns. A trusted checkout's own `.codex/config.toml` would load beneath
 * the `-c` overrides, so a checkout carrying one is refused rather than run.
 *
 * What the CLI cannot promise is declared (`DELEGATION_HARNESS_CONTROLS.codex.limits`): `-c`
 * overrides are not validated, there is no turn cap, the account is not observable, and the
 * harness writes its own session log. Nothing here reads a credential: `CODEX_HOME` is passed by
 * name when the engine's environment sets it, so the operator's own sign-in is used.
 */
export const CODEX_EXECUTABLE_ENVIRONMENT_KEY = 'AI_USAGE_CODEX_EXECUTABLE';
export const CODEX_HOME_ENVIRONMENT_KEY = 'CODEX_HOME';
/** The checkout file Codex loads for a trusted project; its presence refuses the launch. */
export const CODEX_PROJECT_CONFIG_PATH = '.codex/config.toml';
/** Long names of every option the argument vector relies on; each must appear in `codex exec --help`. */
export const CODEX_REVIEW_REQUIRED_FLAGS = [
  '--cd',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--sandbox',
  '--config',
  '--disable',
  '--json',
  '--color',
  '--output-last-message',
] as const;

const HARNESS = 'codex' as const;
const HELP_TIMEOUT_MS = 15_000;
const HELP_OUTPUT_BYTES = 256 * 1024;
const VERSION = /(\d+\.\d+\.\d+)\b/u;
/** Effort reaches a TOML string literal; only a short bare token may. */
const EFFORT_TOKEN = /^[A-Za-z0-9_-]{1,32}$/u;
const MAX_THREAD_ID_LENGTH = 512;
const MAX_FAILURE_DETAIL = 200;
const CODEX_USAGE_FIELDS = {
  cached: 'cached_input_tokens',
  input: 'input_tokens',
  output: 'output_tokens',
} as const;
/** Shapes that would be a credential if a harness error ever echoed one; replaced before storage. */
const SECRET_SHAPES = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gu,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/gu,
];

export interface CodexCommand {
  readonly command: string;
  /** `CODEX_HOME` when the source sets it; the sign-in lives there. */
  readonly environment: Readonly<Record<string, string>>;
}

/** `codex`, a bare name, or an absolute path; a relative path is refused as for Claude (`claudeCommandFor`). */
export const codexCommandFor = (
  env: Readonly<Record<string, string | undefined>>,
  override?: string,
): CodexCommand | { readonly message: string } => {
  const named = override ?? env[CODEX_EXECUTABLE_ENVIRONMENT_KEY] ?? 'codex';
  if (named.includes('/') && !path.isAbsolute(named)) {
    return {
      message: `${CODEX_EXECUTABLE_ENVIRONMENT_KEY} must be an absolute path or a bare command name; got "${named}"`,
    };
  }
  const home = env[CODEX_HOME_ENVIRONMENT_KEY];
  return {
    command: named,
    environment: home === undefined || home === '' ? {} : { [CODEX_HOME_ENVIRONMENT_KEY]: home },
  };
};

export interface CodexReviewArgumentsInput {
  readonly checkoutPath: string;
  readonly effort: string | null;
  readonly model: string | null;
  /** The `-o` file; its name carries the launch marker, so the process table names the job. */
  readonly outputPath: string;
  readonly schemaPath: string | null;
}

/** The exact argument vector, exported so tests and the ADR can state it. The prompt arrives on stdin (`-`). */
export const codexReviewArguments = (input: CodexReviewArgumentsInput): string[] => [
  'exec',
  '-C',
  input.checkoutPath,
  '--skip-git-repo-check',
  // No `$CODEX_HOME/config.toml` (auth still uses CODEX_HOME) and no user or project execpolicy rules.
  '--ignore-user-config',
  '--ignore-rules',
  // The harness's own sandbox: model-run commands cannot write.
  '-s',
  'read-only',
  // `exec` takes no approval flag; the policy is set through the config override.
  '-c',
  'approval_policy="never"',
  '-c',
  'mcp_servers={}',
  '-c',
  'web_search="disabled"',
  '-c',
  'hide_agent_reasoning=true',
  '--disable',
  'hooks',
  '--disable',
  'multi_agent',
  ...(input.model === null ? [] : ['-m', input.model]),
  ...(input.effort === null ? [] : ['-c', `model_reasoning_effort="${input.effort}"`]),
  '--json',
  '--color',
  'never',
  '-o',
  input.outputPath,
  ...(input.schemaPath === null ? [] : ['--output-schema', input.schemaPath]),
  '-',
];

const readCli = async (
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> => {
  let result: Awaited<ReturnType<typeof executeBoundedProcess>>;
  try {
    result = await executeBoundedProcess({
      args,
      command: executable,
      env: environment,
      maximumOutputBytes: HELP_OUTPUT_BYTES,
      timeoutMs: HELP_TIMEOUT_MS,
    });
  } catch (error) {
    const kind = error instanceof BoundedProcessError ? error.kind : 'failed';
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'cli-unqualified',
      `codex ${args.join(' ')} ${kind}; the CLI cannot be qualified`,
    );
  }
  if (result.exitCode !== 0) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'cli-unqualified',
      `codex ${args.join(' ')} exited ${result.exitCode}; the CLI cannot be qualified`,
    );
  }
  return result.stdout;
};

/** `codex --version` must answer a version and `codex exec --help` must name every flag relied on. */
export const qualifyCodexCli = async (
  executable: string,
  options: { readonly environment?: Readonly<Record<string, string>>; readonly extraFlags?: readonly string[] } = {},
): Promise<{ readonly flags: ReadonlySet<string>; readonly version: string }> => {
  const environment = options.environment ?? {};
  const version = VERSION.exec(await readCli(executable, ['--version'], environment))?.[1];
  if (version === undefined) {
    throw new ReviewWorkerLaunchError(HARNESS, 'cli-unqualified', 'codex --version did not answer a version number');
  }
  const flags = parseClaudeHelpFlags(await readCli(executable, ['exec', '--help'], environment));
  const missing = [...CODEX_REVIEW_REQUIRED_FLAGS, ...(options.extraFlags ?? [])].filter((flag) => !flags.has(flag));
  if (missing.length > 0) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'cli-unqualified',
      `codex ${version} exec does not offer ${missing.join(', ')}; a read-only review needs every one of them`,
    );
  }
  return { flags, version };
};

const printableDetail = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  // A control character (newline, tab, bell) becomes a space, so the words around it stay apart.
  let text = [...value].map((character) => (isPrintableSkillObservationText(character) ? character : ' ')).join('');
  for (const shape of SECRET_SHAPES) {
    text = text.replace(shape, '[redacted]');
  }
  return text.replace(/\s+/gu, ' ').trim().slice(0, MAX_FAILURE_DETAIL);
};

/** A harness error as the stored reason: the event type and a short, printable, redacted message. */
export const codexFailureReason = (eventType: string, message: unknown): string => {
  const detail = printableDetail(message);
  return detail.length === 0 ? `codex ${eventType}` : `codex ${eventType}: ${detail}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export type CodexExecEvent =
  | { readonly kind: 'agent-message'; readonly text: string }
  | { readonly detail: unknown; readonly eventType: string; readonly kind: 'failure' }
  | { readonly kind: 'thread-started'; readonly threadId: string }
  | { readonly kind: 'turn-completed'; readonly usage: DelegationUsage | null };

/**
 * One `codex exec --json` line, reduced to what the outcome needs: the thread id, each completed
 * turn's usage, the agent's messages, and the harness's failures. Everything else is `null`.
 */
export const parseCodexExecLine = (line: string): CodexExecEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  switch (value.type) {
    case 'thread.started': {
      const threadId = typeof value.thread_id === 'string' ? value.thread_id.trim() : '';
      return threadId.length > 0 && threadId.length <= MAX_THREAD_ID_LENGTH && isPrintableSkillObservationText(threadId)
        ? { kind: 'thread-started', threadId }
        : null;
    }
    case 'turn.completed':
      return { kind: 'turn-completed', usage: harnessUsage(value.usage, CODEX_USAGE_FIELDS) };
    case 'turn.failed':
      return {
        detail: isRecord(value.error) ? value.error.message : value.message,
        eventType: 'turn.failed',
        kind: 'failure',
      };
    case 'error':
      return { detail: value.message, eventType: 'error', kind: 'failure' };
    case 'item.completed': {
      const item = value.item;
      if (isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
        return { kind: 'agent-message', text: item.text };
      }
      return null;
    }
    default:
      return null;
  }
};

/** The first `maxBytes` of a file as UTF-8 text cut at a character boundary; `null` when absent or empty. */
const readBoundedText = async (filePath: string, maxBytes: number): Promise<string | null> => {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = new Uint8Array(maxBytes + 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return null;
    }
    const text = boundTextBytes(new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead)), maxBytes);
    return text.trim().length === 0 ? null : text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const errorCode = (error: unknown): string =>
  isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error';

interface CodexWorkerState {
  failure: string | null;
  finalText: string | null;
  nativeSessionId: string | null;
  turns: number;
  usage: DelegationUsage | null;
}

export const launchCodexReviewWorker = async (
  spec: ReviewWorkerSpec,
  events: ReviewWorkerEvents = {},
  options: ReviewWorkerLaunchOptions = {},
): Promise<ReviewWorkerLaunch> => {
  const env = options.env ?? process.env;
  const codex = codexCommandFor(env, options.executable);
  if (!('command' in codex)) {
    throw new ReviewWorkerLaunchError(HARNESS, 'executable-invalid', codex.message);
  }
  if (!LAUNCH_MARKER_PATTERN.test(spec.launchMarker)) {
    throw new ReviewWorkerLaunchError(HARNESS, 'spawn-failed', 'the launch marker must be a lowercase UUID');
  }
  if (!path.isAbsolute(spec.privateDirectory)) {
    throw new ReviewWorkerLaunchError(HARNESS, 'spawn-failed', 'the private directory must be an absolute path');
  }
  if (spec.effort !== null && !EFFORT_TOKEN.test(spec.effort)) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'spawn-failed',
      'the effort must be a short token (letters, digits, - or _)',
    );
  }
  const environment = workerEnvironment(codex.environment, env);
  const executable = locateExecutable(codex.command, environment.PATH);
  if (executable === null) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'executable-missing',
      `${codex.command} was not found on the allow-listed PATH`,
    );
  }
  // A trusted project's own config would load beneath the overrides; its presence is a refusal, its content is never read.
  const projectConfig = path.join(spec.checkoutPath, CODEX_PROJECT_CONFIG_PATH);
  let projectConfigPresent: boolean;
  try {
    await lstat(projectConfig);
    projectConfigPresent = true;
  } catch (error) {
    projectConfigPresent = errorCode(error) !== 'ENOENT';
  }
  if (projectConfigPresent) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'project-config-present',
      `the checkout carries ${CODEX_PROJECT_CONFIG_PATH}, which Codex would load beneath the read-only overrides; remove or rename it before delegating to Codex`,
    );
  }
  const { version: cliVersion } = await qualifyCodexCli(executable, {
    environment: codex.environment,
    extraFlags: [
      ...(spec.model === null ? [] : ['--model']),
      ...(spec.outputSchema === null ? [] : ['--output-schema']),
    ],
  });
  const token = delegationLaunchMarkerToken(spec.launchMarker);
  const outputPath = path.join(spec.privateDirectory, `${token}.last-message.txt`);
  const schemaPath = spec.outputSchema === null ? null : path.join(spec.privateDirectory, `${token}.schema.json`);
  const privateFiles = [outputPath, ...(schemaPath === null ? [] : [schemaPath])];
  const removePrivateFiles = async (): Promise<void> => {
    await Promise.all(privateFiles.map((file) => rm(file, { force: true }).catch(() => undefined)));
  };
  if (schemaPath !== null) {
    try {
      await writeFile(schemaPath, JSON.stringify(spec.outputSchema), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      throw new ReviewWorkerLaunchError(
        HARNESS,
        'spawn-failed',
        `the output schema could not be written to the private directory: ${errorCode(error)}`,
      );
    }
  }
  const args = codexReviewArguments({
    checkoutPath: spec.checkoutPath,
    effort: spec.effort,
    model: spec.model,
    outputPath,
    schemaPath,
  });
  const guarantee: DelegationHarnessGuarantee = {
    cliVersion,
    controls: [...DELEGATION_HARNESS_CONTROLS[HARNESS].controls],
    effort: spec.effort,
    harness: HARNESS,
    limits: [...DELEGATION_HARNESS_CONTROLS[HARNESS].limits],
    model: spec.model,
  };
  const state: CodexWorkerState = { failure: null, finalText: null, nativeSessionId: null, turns: 0, usage: null };
  const consumeLine = async (line: string): Promise<void> => {
    const event = parseCodexExecLine(line);
    if (event === null) {
      return;
    }
    switch (event.kind) {
      case 'thread-started':
        if (state.nativeSessionId === null) {
          state.nativeSessionId = event.threadId;
          // `exec` does not report the model it runs; the engine keeps the requested one as unresolved.
          await Promise.resolve(events.onInit?.(event.threadId, null)).catch(() => undefined);
        }
        return;
      case 'turn-completed':
        state.turns += 1;
        state.usage = addUsage(state.usage, event.usage);
        return;
      case 'agent-message':
        state.finalText = event.text;
        return;
      case 'failure':
        state.failure ??= codexFailureReason(event.eventType, event.detail);
        return;
      default:
        return;
    }
  };
  let child: ReturnType<typeof spawnBoundedJsonlProcess>;
  try {
    child = spawnBoundedJsonlProcess(
      {
        args,
        cwd: spec.checkoutPath,
        env: environment,
        executable,
        heartbeatMs: spec.heartbeatMs,
        maxOutputBytes: spec.maxOutputBytes,
        stdin: spec.prompt,
        timeoutMs: spec.timeoutMs,
      },
      { onHeartbeat: events.onHeartbeat, onLine: consumeLine },
    );
  } catch (error) {
    await removePrivateFiles();
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'spawn-failed',
      `codex could not be started in the checkout: ${spawnFailureDetail(error)}`,
    );
  }
  const outcome = (async (): Promise<ReviewWorkerOutcome> => {
    const end = await child.end;
    // The last message file is the fallback when no agent message was seen in the stream.
    const finalText = state.finalText ?? (await readBoundedText(outputPath, DELEGATION_BOUNDS.maxWorkerFinalTextBytes));
    await removePrivateFiles();
    const base = {
      durationMs: end.wallMs,
      exitCode: end.exitCode,
      finalText: boundWorkerFinalText(finalText),
      nativeSessionId: state.nativeSessionId,
      numTurns: state.turns > 0 ? state.turns : null,
      resolvedModel: null,
      usage: state.usage,
    };
    if (end.stop !== null) {
      return { ...base, ...describeProcessStop(end.stop, spec), kind: 'failed' };
    }
    if (state.failure !== null) {
      return { ...base, failureReason: state.failure, kind: 'failed', resultKind: 'error' };
    }
    if (end.exitCode !== 0) {
      return {
        ...base,
        failureReason: `exit ${end.exitCode}${base.finalText === null ? ' without a final message' : ''}`,
        kind: 'failed',
        resultKind: 'error',
      };
    }
    if (base.finalText === null) {
      return { ...base, failureReason: 'exit 0 without a final message', kind: 'failed', resultKind: 'error' };
    }
    return { ...base, failureReason: null, kind: 'finished', resultKind: 'review' };
  })();
  return { args, guarantee, outcome, pid: child.pid, terminate: (reason) => child.stop(reason) };
};

export const codexReviewWorkerAdapter: ReviewWorkerAdapter = { harness: HARNESS, launch: launchCodexReviewWorker };
