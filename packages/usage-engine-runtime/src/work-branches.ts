import { readLocalDefaultBranch, readSshHostAliases } from '@ai-usage/local-machine/local-git';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import {
  type ReconcileWorkBranchesResult,
  reconcileWorkBranches,
  type UsageStoreError,
} from '@ai-usage/usage-store/writer';
import type { Effect } from 'effect';

/**
 * Branch evidence (ADR 0081) with this machine's facts: `~/.ssh/config` host aliases (the config
 * may add or override some), the configured shared branches and each clone's `origin/HEAD`.
 */
export const reconcileWorkBranchesFromHome = (input: {
  readonly config: AiUsageConfig;
  readonly dbPath: string;
  readonly home: string;
  readonly machineId: string;
  readonly now: Date;
}): Effect.Effect<ReconcileWorkBranchesResult, UsageStoreError> =>
  reconcileWorkBranches({
    dbPath: input.dbPath,
    defaultBranchOf: readLocalDefaultBranch,
    hostAliases: { ...readSshHostAliases(input.home), ...input.config.github?.hostAliases },
    machineId: input.machineId,
    now: input.now.toISOString(),
    sharedBranches: input.config.github?.sharedBranches ?? [],
  });
