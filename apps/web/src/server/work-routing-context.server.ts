import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type { ReviewTargetDeclaration } from '@ai-usage/report-core/work-attempts';
import type { ExecutorDeclaration, ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { buildRoutingQualification, qualifyReviewRouting } from '@ai-usage/report-core/work-routing';
import {
  parseWebUsageEngineCommand,
  type UsageEngineCommandCompletion,
  type WebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';
import { queryLatestExecutorObservations, usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import {
  parseWorkRoutingContext,
  parseWorkRoutingQualifyOutput,
  type WorkRoutingContext,
  type WorkRoutingQualifyInput,
  type WorkRoutingQualifyOutput,
} from '@ai-usage/web-contract/work-routing';
import { Effect } from 'effect';
import type { RuntimeMode } from '../runtime-mode';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/**
 * Assembles the Work view's routing context: the operator's declarations from the home config and
 * the engine's latest executor observations from the usage store, both read-only. The store is
 * opened through the query-only reader (ADR 0009); the config is never written here.
 */
export interface WorkRoutingContextReaders {
  readonly now?: () => Date;
  readonly readDeclarations: () => Promise<{
    readonly configPath: string;
    readonly declarations: readonly ExecutorDeclaration[];
    readonly issues: readonly { readonly path: string; readonly reason: string }[];
    readonly machineId: string | null;
    /** `routing.reviewTargets[]` issues (ADR 0053); absent readers mean none were read. */
    readonly reviewTargetIssues?: readonly { readonly path: string; readonly reason: string }[];
    readonly reviewTargets?: readonly ReviewTargetDeclaration[];
  }>;
  readonly readObservations: (machineId: string | null) => Promise<{
    readonly observations: readonly ExecutorObservation[];
    readonly skipped: number;
    readonly truncated: boolean;
  }>;
}

const EMPTY_OBSERVATIONS = { observations: [], skipped: 0, truncated: false } as const;

export const createWorkRoutingContextReaders = (
  paths: ReturnType<typeof resolveUsageWebRuntimePaths> = resolveUsageWebRuntimePaths(),
): WorkRoutingContextReaders => ({
  readDeclarations: () => readLocalRoutingDeclarations(paths.homeDirectory),
  readObservations: async (machineId) => {
    const outcome = await Effect.runPromise(
      Effect.either(
        queryLatestExecutorObservations({
          dbPath: paths.databasePath,
          ...(machineId === null ? {} : { machineId }),
        }),
      ),
    );
    if (outcome._tag === 'Right') {
      return outcome.right;
    }
    // A machine that has never collected has no store yet; that is an empty answer, not a failure.
    // Every other reason (older schema without the table, corruption, busy) stays a failure.
    if (usageStoreErrorReasonFrom(outcome.left) === 'store-missing') {
      return EMPTY_OBSERVATIONS;
    }
    throw outcome.left;
  },
});

export const getWorkRoutingContextForServer = async (
  readers: WorkRoutingContextReaders = createWorkRoutingContextReaders(),
  options: { readonly signal?: AbortSignal } = {},
): Promise<WorkRoutingContext> => {
  options.signal?.throwIfAborted();
  const declared = await readers.readDeclarations();
  options.signal?.throwIfAborted();
  const observed = await readers.readObservations(declared.machineId);
  options.signal?.throwIfAborted();
  return parseWorkRoutingContext({
    configPath: declared.configPath,
    declarationErrors: declared.issues.map((issue) => `${issue.path}: ${issue.reason}`),
    declarations: declared.declarations,
    executorObservations: observed.observations,
    generatedAt: (readers.now ?? (() => new Date()))().toISOString(),
    machineId: declared.machineId,
    observationRead: { skipped: observed.skipped, truncated: observed.truncated },
    reviewTargetErrors: (declared.reviewTargetIssues ?? []).map((issue) => `${issue.path}: ${issue.reason}`),
    reviewTargets: declared.reviewTargets ?? [],
  });
};

/** Deterministic Playwright fixture: one declared Claude route and one signed-in observation. */
export const e2eWorkRoutingContext = (): WorkRoutingContext =>
  parseWorkRoutingContext({
    configPath: '/fixture/.config/ai-usage/config.json',
    declarationErrors: [],
    declarations: [
      {
        accountScope: 'fixture-subscription',
        authorization: 'allowed',
        capabilities: ['read-only-review'],
        declaredAt: '2026-06-10T08:00:00.000Z',
        effort: null,
        harness: 'claude-code',
        machineId: 'fixture-machine',
        model: null,
        quality: 'review-capable',
        subscription: 'verified',
        targets: [{ kind: 'any-local-session' }],
      },
    ],
    executorObservations: [
      {
        authEvidence: 'claude auth status exit 0 loggedIn=true',
        authMethod: 'claude.ai',
        authState: 'logged-in',
        binaryPath: '/fixture/bin/claude',
        harness: 'claude-code',
        machineId: 'fixture-machine',
        observedAt: '2026-06-11T09:00:00.000Z',
        outcome: 'observed',
        version: '2.1.303 (Claude Code)',
      },
    ],
    generatedAt: '2026-06-11T09:05:00.000Z',
    machineId: 'fixture-machine',
    observationRead: { skipped: 0, truncated: false },
  });

// ---------------------------------------------------------------------------------------------
// workRouting.qualify (ADR 0057): one engine command, relayed; the Web process decides nothing
// ---------------------------------------------------------------------------------------------

type QualifyReviewRoutingCommand = Extract<WebUsageEngineCommand, { readonly command: 'qualify-review-routing' }>;

export type ExecuteQualifyReviewRoutingCommand = (
  command: QualifyReviewRoutingCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

const qualifyFailure = (tag: 'ForbiddenDemo' | 'Unavailable', message: string): WorkRoutingQualifyOutput =>
  parseWorkRoutingQualifyOutput({ error: { message, tag }, ok: false });

const executeQualifyCommand: ExecuteQualifyReviewRoutingCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

/**
 * The synthetic e2e runtime has no engine: its answer is the same pure decision computed from the
 * e2e routing fixture, with no quota (so it is never a real recommendation), and is labelled as such
 * by its executor outcome `not-run`.
 */
export const e2eWorkRoutingQualification = (input: WorkRoutingQualifyInput, now: Date): WorkRoutingQualifyOutput => {
  const context = e2eWorkRoutingContext();
  const decided = qualifyReviewRouting({
    declarations: context.declarations,
    executorObservations: context.executorObservations,
    now: now.toISOString(),
    providers: [],
    target: {
      harness: input.target.harness,
      kind: 'session',
      machineId: context.machineId ?? 'fixture-machine',
      sourceSessionId: input.target.sourceSessionId,
    },
  });
  return parseWorkRoutingQualifyOutput({
    data: buildRoutingQualification({ ...decided, executors: { outcome: 'not-run', refreshed: false } }),
    ok: true,
  });
};

export const qualifyWorkRoutingForServer = async (
  input: WorkRoutingQualifyInput,
  execute: ExecuteQualifyReviewRoutingCommand = executeQualifyCommand,
  options: { readonly mode?: RuntimeMode; readonly now?: () => Date; readonly signal?: AbortSignal } = {},
): Promise<WorkRoutingQualifyOutput> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return qualifyFailure('ForbiddenDemo', 'Routing qualification is not available in the demo.');
  }
  if (mode === 'e2e') {
    return e2eWorkRoutingQualification(input, (options.now ?? (() => new Date()))());
  }
  const command = parseWebUsageEngineCommand({
    command: 'qualify-review-routing',
    target: {
      desktopSessionId: input.target.desktopSessionId ?? null,
      harness: input.target.harness,
      sourceSessionId: input.target.sourceSessionId,
    },
  });
  if (command.command !== 'qualify-review-routing') {
    throw new Error('Expected a routing qualification command.');
  }
  let completion: UsageEngineCommandCompletion;
  try {
    completion = await execute(command, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return qualifyFailure('Unavailable', 'The engine could not qualify the routing; it may be stopped or busy.');
  }
  if (completion.state !== 'succeeded' || completion.command !== 'qualify-review-routing') {
    return qualifyFailure('Unavailable', 'The engine did not complete the routing qualification.');
  }
  return parseWorkRoutingQualifyOutput({ data: completion.output.qualification, ok: true });
};

export const qualifyWorkRoutingFromRequestForServer = async (
  request: Request,
  input: WorkRoutingQualifyInput,
  execute?: ExecuteQualifyReviewRoutingCommand,
  mode?: RuntimeMode,
): Promise<WorkRoutingQualifyOutput> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await qualifyWorkRoutingForServer(input, execute, {
    ...(mode === undefined ? {} : { mode }),
    signal: request.signal,
  });
};
