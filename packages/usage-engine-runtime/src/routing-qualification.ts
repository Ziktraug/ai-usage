import type { LocalHistoryStorage as LocalHistoryStorageService } from '@ai-usage/local-machine/local-history';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  buildRoutingQualification,
  qualifyReviewRouting,
  type RoutingQualificationExecutors,
} from '@ai-usage/report-core/work-routing';
import {
  queryLatestExecutorObservations,
  queryLatestProviderQuotaObservations,
  queryReviewTargetResolution,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import type { RoutingQualificationExecutorRun, UsageEngineRoutingQualificationPort } from './runtime';

/**
 * The engine side of an on-demand routing qualification (ADR 0057). The command executor first
 * runs the `executors.capabilities` source, so the executor observation is the one taken now; this
 * service then re-reads the declarations from the home config and the latest executor and quota
 * observations from the store, and decides with the same pure functions a launch uses. It writes
 * nothing, starts nothing, and returns a bounded decision rather than report data.
 */
export interface RoutingQualificationServiceOptions {
  readonly dbPath: string;
  /** Resolved lazily: the engine knows its machine only after `validateConfig`. */
  readonly machine: () => UsageMachine;
  readonly now?: () => Date;
  readonly storage: LocalHistoryStorageService;
}

/** What the source reported for the run this qualification asked for. */
export const executorRunOutcome = (run: RoutingQualificationExecutorRun): RoutingQualificationExecutors => {
  const source = run.source;
  if (source === null) {
    return { outcome: 'not-run', refreshed: false };
  }
  if (source.policy === 'disabled') {
    return { outcome: 'disabled', refreshed: false };
  }
  if (source.availability === 'not-detected') {
    return { outcome: 'not-detected', refreshed: false };
  }
  const finishedAt = source.lastFinishedAt === undefined ? Number.NaN : Date.parse(source.lastFinishedAt);
  const concluded = source.lastOutcome === 'success' || source.lastOutcome === 'warning';
  return {
    outcome: source.lastOutcome,
    refreshed: concluded && Number.isFinite(finishedAt) && finishedAt >= Date.parse(run.startedAt),
  };
};

export const createRoutingQualificationService = (
  options: RoutingQualificationServiceOptions,
): UsageEngineRoutingQualificationPort => {
  const now = options.now ?? (() => new Date());
  return {
    qualify: async (command, executorRun, signal) => {
      signal?.throwIfAborted();
      const machineId = options.machine().id;
      const [routing, observations, quotas, facts] = await Promise.all([
        readLocalRoutingDeclarations(options.storage.home),
        Effect.runPromise(queryLatestExecutorObservations({ dbPath: options.dbPath, machineId })),
        Effect.runPromise(queryLatestProviderQuotaObservations({ dbPath: options.dbPath, machineId })),
        Effect.runPromise(
          queryReviewTargetResolution({
            dbPath: options.dbPath,
            desktopSessionId: command.target.desktopSessionId,
            harness: command.target.harness,
            machineId,
            sourceSessionId: command.target.sourceSessionId,
          }),
        ),
      ]);
      signal?.throwIfAborted();
      const decided = qualifyReviewRouting({
        declarations: routing.declarations,
        executorObservations: observations.observations,
        now: now().toISOString(),
        providers: quotas.observations.map(projectLatestProviderQuotaObservation),
        target: {
          harness: command.target.harness,
          kind: 'session',
          machineId,
          projectLabel: facts.session?.projectLabel ?? null,
          sourceSessionId: command.target.sourceSessionId,
        },
      });
      return {
        kind: 'routing-qualification',
        qualification: buildRoutingQualification({ ...decided, executors: executorRunOutcome(executorRun) }),
      };
    },
  };
};
