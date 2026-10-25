import { boundedProcessEnvironment } from '@ai-usage/local-machine/bounded-process';
import type { DelegationHarnessGuarantee, DelegationUsage } from '@ai-usage/report-core/delegation-contracts';
import {
  DELEGATION_BOUNDS,
  DELEGATION_DEPTH_ENVIRONMENT_KEY,
  type DelegationExecutorHarness,
} from '@ai-usage/report-core/delegation-vocabulary';
import type { ProcessStopReason } from './review-worker-process';

/**
 * The contract every delegation worker adapter satisfies (DESIGN "Workers"). The engine builds the
 * prompt and the spec, picks the adapter for the chosen route's harness, and reads one outcome; the
 * adapter qualifies the CLI, enforces the harness's read-only controls, spawns through the shared
 * bounded runner (`review-worker-process.ts`) and reads the harness's own event stream. Nothing
 * here is a result judgement: `review` only means the worker produced a final text; the engine
 * parses it against the output contract.
 */
export interface ReviewWorkerSpec {
  readonly checkoutPath: string;
  readonly effort: string | null;
  readonly heartbeatMs: number;
  /** A lowercase UUID the engine recorded before the spawn; carried in the argument vector (ADR 0055). */
  readonly launchMarker: string;
  readonly maxOutputBytes: number;
  /** Harness turn cap where the harness has one (Claude); Codex is bounded by the deadline only. */
  readonly maxTurns: number;
  readonly model: string | null;
  /** JSON Schema of the final message, for harnesses that take one (Codex `--output-schema`); `null` = none. */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  /** An absolute, engine-owned directory created with mode 0700 by the caller; private files go here. */
  readonly privateDirectory: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ReviewWorkerEvents {
  /** Fired every `heartbeatMs` while the process lives; the engine stamps `updated_at` with it. */
  readonly onHeartbeat?: () => Promise<void> | void;
  /** Fired once, with the harness's own session id and the model it reported running (`null` when it reports none). */
  readonly onInit?: (nativeSessionId: string, resolvedModel: string | null) => Promise<void> | void;
}

export type ReviewWorkerResultKind = 'cancelled' | 'error' | 'review' | 'timeout';

export interface ReviewWorkerOutcome {
  readonly durationMs: number;
  /** The process's exit code, or 128 + the signal number when it was killed. */
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  /** The worker's final message, at most `DELEGATION_BOUNDS.maxWorkerFinalTextBytes`, cut at a character boundary. */
  readonly finalText: string | null;
  readonly kind: 'failed' | 'finished';
  readonly nativeSessionId: string | null;
  readonly numTurns: number | null;
  readonly resolvedModel: string | null;
  readonly resultKind: ReviewWorkerResultKind;
  readonly usage: DelegationUsage | null;
}

export type ReviewWorkerTerminationReason = 'cancel' | 'shutdown' | 'timeout';

export interface ReviewWorkerLaunch {
  /** The argument vector as spawned, for tests and the ADR; never logged (it carries the prompt). */
  readonly args: readonly string[];
  readonly guarantee: DelegationHarnessGuarantee;
  readonly outcome: Promise<ReviewWorkerOutcome>;
  readonly pid: number;
  /** Asks the process to stop (SIGTERM, then SIGKILL after the grace period); the outcome still settles. */
  readonly terminate: (reason: ReviewWorkerTerminationReason) => void;
}

export interface ReviewWorkerLaunchOptions {
  /** Source environment; defaults to `process.env`. Only the allow-listed names reach the child. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the harness executable (absolute path or bare name), as the environment variable would. */
  readonly executable?: string;
}

export interface ReviewWorkerAdapter {
  readonly harness: DelegationExecutorHarness;
  readonly launch: (
    spec: ReviewWorkerSpec,
    events: ReviewWorkerEvents,
    options: ReviewWorkerLaunchOptions,
  ) => Promise<ReviewWorkerLaunch>;
}

export type ReviewWorkerLaunchFailureKind =
  | 'cli-unqualified'
  | 'executable-invalid'
  | 'executable-missing'
  | 'project-config-present'
  | 'spawn-failed';

export class ReviewWorkerLaunchError extends Error {
  readonly harness: DelegationExecutorHarness;
  readonly kind: ReviewWorkerLaunchFailureKind;

  constructor(harness: DelegationExecutorHarness, kind: ReviewWorkerLaunchFailureKind, message: string) {
    super(message);
    this.name = 'ReviewWorkerLaunchError';
    this.harness = harness;
    this.kind = kind;
  }
}

/** The token a worker's argument vector carries, so the process table names the job (ADR 0055). */
export const delegationLaunchMarkerToken = (marker: string): string => `ai-usage-delegation-${marker}`;

export const LAUNCH_MARKER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface DelegationHarnessControls {
  /** What the adapter enforces per invocation; the guarantee lists them verbatim. */
  readonly controls: readonly string[];
  /** What those controls do not cover; shown wherever the guarantee is shown. */
  readonly limits: readonly string[];
}

/** Exactly what each adapter enforces and what it cannot; the guarantee of a launch is this plus the CLI version, model and effort. */
export const DELEGATION_HARNESS_CONTROLS: Readonly<Record<DelegationExecutorHarness, DelegationHarnessControls>> = {
  'claude-code': {
    controls: [
      'tools limited to Read, Grep and Glob',
      'no user, project or local settings (no hooks)',
      'safe mode (no plugins, skills, CLAUDE.md or MCP servers)',
      'plan permission mode',
      'no MCP servers',
    ],
    limits: [
      'managed policy settings cannot be excluded',
      'turn cap not qualifiable from --help',
      'the harness writes its own session log',
    ],
  },
  codex: {
    controls: [
      'Codex sandbox read-only',
      'approvals never',
      'user config and exec rules ignored',
      'no MCP servers',
      'web search disabled',
      'hooks and multi-agent disabled',
      'refuses a checkout carrying .codex/config.toml',
    ],
    limits: [
      '-c overrides are not validated by the CLI',
      'no turn cap (the deadline bounds the run)',
      'account identity not observable',
      'the harness writes its own session log',
    ],
  },
};

/**
 * The environment every worker receives: the bounded allow-list of `source`, the adapter's explicit
 * variables, and the delegation depth, so a worker that asks AI Usage for a delegation is refused
 * (`recursive-delegation`).
 */
export const workerEnvironment = (
  explicit: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  boundedProcessEnvironment({ ...explicit, [DELEGATION_DEPTH_ENVIRONMENT_KEY]: '1' }, source);

/** How a process the runner stopped is reported, the same for every adapter. */
export const describeProcessStop = (
  stop: ProcessStopReason,
  limits: { readonly maxOutputBytes: number; readonly timeoutMs: number },
): { readonly failureReason: string; readonly resultKind: ReviewWorkerResultKind } => {
  switch (stop) {
    case 'deadline':
      return {
        failureReason: `timed out after ${Math.round(limits.timeoutMs / 1000)} s; the process was terminated`,
        resultKind: 'timeout',
      };
    case 'timeout':
      return { failureReason: 'terminated by the engine (timeout)', resultKind: 'timeout' };
    case 'overflow':
      return {
        failureReason: `stdout exceeded ${limits.maxOutputBytes} bytes; the process was terminated`,
        resultKind: 'error',
      };
    case 'cancel':
      return { failureReason: 'cancelled by the engine', resultKind: 'cancelled' };
    case 'shutdown':
      return { failureReason: 'terminated at engine shutdown', resultKind: 'error' };
    default:
      return { failureReason: 'terminated by the engine', resultKind: 'error' };
  }
};

/** An absolute path as given; a bare name looked up on the allow-listed PATH only; `null` when absent. */
export const locateExecutable = (command: string, pathVariable: string | undefined): string | null =>
  command.includes('/') ? command : Bun.which(command, { PATH: pathVariable ?? '' });

const encoder = new TextEncoder();

/** The text cut to at most `maxBytes` of UTF-8 at a character boundary (never inside a sequence). */
export const boundTextBytes = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx, 0x80..0xbf) so the cut lands before a whole character.
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
};

/** The worker's final message, bounded for storage and parsing; `null` when there is none. */
export const boundWorkerFinalText = (text: string | null): string | null =>
  text === null ? null : boundTextBytes(text, DELEGATION_BOUNDS.maxWorkerFinalTextBytes);

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Tokens as a harness reports them in one of its usage objects; `null` when none of the three
 * counters is present. Field names are the harness's own, mapped here and nowhere else.
 */
export const harnessUsage = (
  value: unknown,
  fields: { readonly cached: string; readonly input: string; readonly output: string },
): DelegationUsage | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const usage = {
    cachedInputTokens: nonNegativeInteger(record[fields.cached]),
    inputTokens: nonNegativeInteger(record[fields.input]),
    outputTokens: nonNegativeInteger(record[fields.output]),
  };
  if (usage.cachedInputTokens === null && usage.inputTokens === null && usage.outputTokens === null) {
    return null;
  }
  return { ...usage, source: 'harness-reported' };
};

/** Two usage readings added counter by counter; a counter unknown on one side stays what the other says. */
export const addUsage = (left: DelegationUsage | null, right: DelegationUsage | null): DelegationUsage | null => {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  const add = (a: number | null, b: number | null): number | null => {
    if (a === null) {
      return b;
    }
    return b === null ? a : a + b;
  };
  return {
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    source: 'harness-reported',
  };
};
