import type { SourcePolicyOverrides } from '@ai-usage/report-core/source-control';
import { Effect } from 'effect';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { readAiUsageConfig } from './machine-config';

/**
 * Reads the current machine's persisted source-policy overrides without
 * exposing the rest of machine configuration to Web.
 *
 * Source policy is home-only by existing configuration semantics; repository
 * config cannot select background collection sources.
 */
export const readLocalSourcePolicyOverrides = async (homePath?: string): Promise<SourcePolicyOverrides> => {
  const storage = createLocalHistoryStorage(homePath);
  const config = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  return config.sourcePolicies ?? {};
};
