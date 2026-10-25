import type { DelegationConfig, DelegationConfigIssue } from '@ai-usage/report-core/delegation-contracts';
import {
  delegationCatalogRevision,
  delegationPolicyRevision,
  parseDelegationConfig,
} from '@ai-usage/report-core/delegation-policy';
import type { AiUsageGitHubAccountConfig } from '@ai-usage/report-core/project-alias';
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
  /** The home `delegation` section parsed tolerantly (ADR 0077); every default when it is absent. */
  readonly delegation: { readonly config: DelegationConfig; readonly issues: readonly DelegationConfigIssue[] };
  /** `github.accounts[]` as declared: the `gh` login per repository owner, a checkout fact delegation rules match. */
  readonly githubAccounts: readonly AiUsageGitHubAccountConfig[];
  /** Entries that were rejected, by config path and reason, never by value. */
  readonly issues: readonly ExecutorDeclarationIssue[];
  /** This machine's identity from `machine.json`, or `null` when the engine has never created one. */
  readonly machineId: string | null;
  /** `routing.reviewTargets[]` entries that failed, located the same way. */
  readonly reviewTargetIssues: readonly ReviewTargetDeclarationIssue[];
  /** Checkouts a launched review may run in (ADR 0053); empty means no launch is possible. */
  readonly reviewTargets: readonly ReviewTargetDeclaration[];
  /**
   * Digests of the raw sections a delegation qualification is decided under: the policy (routing,
   * delegation, github) and the model catalog (`delegation.models`). A config write changes them.
   */
  readonly revisions: { readonly catalogRevision: string; readonly policyRevision: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the current machine's persisted review-routing declarations without exposing the rest of
 * machine configuration to Web, and without writing anything.
 *
 * Routing is home-only by configuration semantics, like source policy: repository config cannot
 * authorize a harness to act. A declaration that omits `machineId` means this machine, identified
 * by the same `machine.json` identity the engine stamps on session rows and quota observations.
 * The `delegation` section follows the same rule and is read here with its revisions, so one read
 * gives the engine every fact a qualification depends on.
 */
export const readLocalRoutingDeclarations = async (homePath?: string): Promise<LocalRoutingDeclarations> => {
  const storage = createLocalHistoryStorage(homePath);
  const provide = <A, E>(effect: Effect.Effect<A, E, typeof LocalHistoryStorage.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  const [config, machine] = await Promise.all([provide(readAiUsageConfig), provide(readMachineConfigIfPresent)]);
  const machineId = machine?.id ?? null;
  const parsed = parseExecutorDeclarations(config.routing, { defaultMachineId: machineId, path: 'routing' });
  const reviewTargets = parseReviewTargetDeclarations(config.routing?.reviewTargets, { path: 'routing.reviewTargets' });
  const delegation = parseDelegationConfig(config.delegation, { defaultMachineId: machineId, path: 'delegation' });
  const [policyRevision, catalogRevision] = await Promise.all([
    delegationPolicyRevision({ delegation: config.delegation, github: config.github, routing: config.routing }),
    delegationCatalogRevision(isRecord(config.delegation) ? config.delegation.models : undefined),
  ]);
  return {
    configPath: aiUsageConfigPath(storage),
    declarations: parsed.declarations,
    delegation: { config: delegation.config, issues: delegation.issues },
    githubAccounts: config.github?.accounts ?? [],
    issues: parsed.issues,
    machineId,
    reviewTargetIssues: reviewTargets.issues,
    reviewTargets: reviewTargets.targets,
    revisions: { catalogRevision, policyRevision },
  };
};
