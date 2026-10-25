import type { DelegationHarnessGuarantee, DelegationUsage } from '@ai-usage/report-core/delegation-contracts';
import { DELEGATION_DEPTH_ENVIRONMENT_KEY } from '@ai-usage/report-core/delegation-vocabulary';
import { isPrintableSkillObservationText } from '@ai-usage/report-core/skill-observation';
import { type ClaudeStreamEvent, parseClaudeStreamJsonLine } from '@ai-usage/report-core/work-attempts';
import { CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY, resolveClaudeExecutable } from './claude-command';
import { ClaudeCliQualificationError, qualifyClaudeCli } from './claude-review-cli';
import { claudeReviewArguments } from './claude-review-launcher';
import {
  boundWorkerFinalText,
  DELEGATION_HARNESS_CONTROLS,
  describeProcessStop,
  harnessUsage,
  LAUNCH_MARKER_PATTERN,
  type ReviewWorkerAdapter,
  type ReviewWorkerEvents,
  type ReviewWorkerLaunch,
  ReviewWorkerLaunchError,
  type ReviewWorkerLaunchOptions,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
} from './review-worker';
import { spawnBoundedJsonlProcess, spawnFailureDetail } from './review-worker-process';

/**
 * The Claude Code delegation worker: the review launcher's argument vector (`claudeReviewArguments`,
 * ADR 0053/0055) and CLI qualification (`qualifyClaudeCli`), with the launch marker as
 * `--session-id`, the engine-built prompt, and `AI_USAGE_DELEGATION_DEPTH=1` in the allow-listed
 * environment. The `stream-json` output is read with the shared parser, extended here to keep the
 * `model` the `system/init` message names and the `usage` counters the `result` message carries.
 */
const HARNESS = 'claude-code' as const;
const MAX_MODEL_LENGTH = 256;
const CLAUDE_USAGE_FIELDS = {
  cached: 'cache_read_input_tokens',
  input: 'input_tokens',
  output: 'output_tokens',
} as const;

export type ClaudeWorkerStreamEvent =
  | (Extract<ClaudeStreamEvent, { kind: 'init' }> & { readonly model: string | null })
  | (Extract<ClaudeStreamEvent, { kind: 'result' }> & { readonly usage: DelegationUsage | null });

const boundedModel = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const model = value.trim();
  return model.length > 0 && model.length <= MAX_MODEL_LENGTH && isPrintableSkillObservationText(model) ? model : null;
};

/**
 * One `stream-json` line as the worker reads it: what `parseClaudeStreamJsonLine` keeps, plus the
 * reported model on `init` and the token counters on `result`. Every other line stays `null`.
 */
export const parseClaudeWorkerStreamLine = (line: string): ClaudeWorkerStreamEvent | null => {
  const event = parseClaudeStreamJsonLine(line);
  if (event === null) {
    return null;
  }
  // The shared parser accepted the line as a JSON object; the fields it does not keep are read here.
  const raw = JSON.parse(line.trim()) as Record<string, unknown>;
  if (event.kind === 'init') {
    return { ...event, model: boundedModel(raw.model) };
  }
  return { ...event, usage: harnessUsage(raw.usage, CLAUDE_USAGE_FIELDS) };
};

interface ClaudeWorkerState {
  durationMs: number | null;
  isError: boolean;
  model: string | null;
  nativeSessionId: string | null;
  numTurns: number | null;
  resultSeen: boolean;
  resultSubtype: string | null;
  text: string | null;
  usage: DelegationUsage | null;
}

export const launchClaudeReviewWorker = async (
  spec: ReviewWorkerSpec,
  events: ReviewWorkerEvents = {},
  options: ReviewWorkerLaunchOptions = {},
): Promise<ReviewWorkerLaunch> => {
  const env = options.env ?? process.env;
  const resolved = resolveClaudeExecutable(env, options.executable, { [DELEGATION_DEPTH_ENVIRONMENT_KEY]: '1' });
  if (resolved.kind !== 'resolved') {
    throw new ReviewWorkerLaunchError(HARNESS, resolved.kind, resolved.message);
  }
  if (!LAUNCH_MARKER_PATTERN.test(spec.launchMarker)) {
    throw new ReviewWorkerLaunchError(HARNESS, 'spawn-failed', 'the launch marker must be a lowercase UUID');
  }
  const { environment, executable } = resolved;
  const configDirectory = environment[CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY];
  let cliVersion: string;
  try {
    ({ version: cliVersion } = await qualifyClaudeCli(executable, {
      environment: configDirectory === undefined ? {} : { [CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY]: configDirectory },
      extraFlags: [...(spec.model === null ? [] : ['--model']), ...(spec.effort === null ? [] : ['--effort'])],
    }));
  } catch (error) {
    if (error instanceof ClaudeCliQualificationError) {
      throw new ReviewWorkerLaunchError(HARNESS, 'cli-unqualified', error.message);
    }
    throw error;
  }
  const args = claudeReviewArguments(
    { effort: spec.effort, launchSessionId: spec.launchMarker, maxTurns: spec.maxTurns, model: spec.model },
    spec.prompt,
  );
  const guarantee: DelegationHarnessGuarantee = {
    cliVersion,
    controls: [...DELEGATION_HARNESS_CONTROLS[HARNESS].controls],
    effort: spec.effort,
    harness: HARNESS,
    limits: [...DELEGATION_HARNESS_CONTROLS[HARNESS].limits],
    model: spec.model,
  };
  const state: ClaudeWorkerState = {
    durationMs: null,
    isError: false,
    model: null,
    nativeSessionId: null,
    numTurns: null,
    resultSeen: false,
    resultSubtype: null,
    text: null,
    usage: null,
  };
  const consumeLine = async (line: string): Promise<void> => {
    const event = parseClaudeWorkerStreamLine(line);
    if (event === null) {
      return;
    }
    if (event.kind === 'init') {
      if (state.nativeSessionId === null) {
        state.nativeSessionId = event.sessionId;
        state.model = event.model;
        await Promise.resolve(events.onInit?.(event.sessionId, event.model)).catch(() => undefined);
      }
      return;
    }
    state.resultSeen = true;
    state.isError = event.isError;
    state.numTurns = event.numTurns;
    state.durationMs = event.durationMs;
    state.resultSubtype = event.subtype;
    state.text = event.text;
    state.usage = event.usage;
    state.nativeSessionId ??= event.sessionId;
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
        stdin: null,
        timeoutMs: spec.timeoutMs,
      },
      { onHeartbeat: events.onHeartbeat, onLine: consumeLine },
    );
  } catch (error) {
    throw new ReviewWorkerLaunchError(
      HARNESS,
      'spawn-failed',
      `claude could not be started in the checkout: ${spawnFailureDetail(error)}`,
    );
  }
  const outcome = (async (): Promise<ReviewWorkerOutcome> => {
    const end = await child.end;
    const base = {
      durationMs: state.durationMs ?? end.wallMs,
      exitCode: end.exitCode,
      finalText: boundWorkerFinalText(state.text),
      nativeSessionId: state.nativeSessionId,
      numTurns: state.numTurns,
      resolvedModel: state.model,
      usage: state.usage,
    };
    if (end.stop !== null) {
      return { ...base, ...describeProcessStop(end.stop, spec), kind: 'failed' };
    }
    if (!state.resultSeen) {
      return {
        ...base,
        failureReason: `exit ${end.exitCode} without a result message`,
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
    if (end.exitCode !== 0) {
      return { ...base, failureReason: `exit ${end.exitCode} after a result`, kind: 'failed', resultKind: 'error' };
    }
    return { ...base, failureReason: null, kind: 'finished', resultKind: 'review' };
  })();
  return { args, guarantee, outcome, pid: child.pid, terminate: (reason) => child.stop(reason) };
};

export const claudeReviewWorkerAdapter: ReviewWorkerAdapter = { harness: HARNESS, launch: launchClaudeReviewWorker };
