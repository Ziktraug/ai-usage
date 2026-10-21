import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type { ExecutorDeclaration, ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { queryLatestExecutorObservations, usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import { parseWorkRoutingContext, type WorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import { Effect } from 'effect';
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
