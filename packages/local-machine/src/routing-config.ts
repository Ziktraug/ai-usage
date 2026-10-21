import {
  parseReviewTargetDeclarations,
  type ReviewTargetDeclaration,
  type ReviewTargetDeclarationIssue,
} from '@ai-usage/report-core/work-attempts';
import {
  type ExecutorDeclaration,
  type ExecutorDeclarationIssue,
  parseExecutorDeclarations,
} from '@ai-usage/report-core/work-executors';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { aiUsageConfigPath, readAiUsageConfig, readMachineConfigIfPresent } from './machine-config';

export interface LocalRoutingDeclarations {
  /** Where the declarations are read from; shown so the operator knows which file to edit. */
  readonly configPath: string;
  readonly declarations: readonly ExecutorDeclaration[];
  /** Entries that were rejected, by config path and reason, never by value. */
  readonly issues: readonly ExecutorDeclarationIssue[];
  /** This machine's identity from `machine.json`, or `null` when the engine has never created one. */
  readonly machineId: string | null;
  /** `routing.reviewTargets[]` entries that failed, located the same way. */
  readonly reviewTargetIssues: readonly ReviewTargetDeclarationIssue[];
  /** Checkouts a launched review may run in (ADR 0053); empty means no launch is possible. */
  readonly reviewTargets: readonly ReviewTargetDeclaration[];
}

/**
 * Reads the current machine's persisted review-routing declarations without exposing the rest of
 * machine configuration to Web, and without writing anything.
 *
 * Routing is home-only by configuration semantics, like source policy: repository config cannot
 * authorize a harness to act. A declaration that omits `machineId` means this machine, identified
 * by the same `machine.json` identity the engine stamps on session rows and quota observations.
 */
export const readLocalRoutingDeclarations = async (homePath?: string): Promise<LocalRoutingDeclarations> => {
  const storage = createLocalHistoryStorage(homePath);
  const provide = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  const [config, machine] = await Promise.all([provide(readAiUsageConfig), provide(readMachineConfigIfPresent)]);
  const parsed = parseExecutorDeclarations(config.routing, { defaultMachineId: machine?.id ?? null, path: 'routing' });
  const reviewTargets = parseReviewTargetDeclarations(config.routing?.reviewTargets, { path: 'routing.reviewTargets' });
  return {
    configPath: aiUsageConfigPath(storage),
    declarations: parsed.declarations,
    issues: parsed.issues,
    machineId: machine?.id ?? null,
    reviewTargetIssues: reviewTargets.issues,
    reviewTargets: reviewTargets.targets,
  };
};
