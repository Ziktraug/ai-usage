import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';
import { usageStorePath } from '@ai-usage/usage-store/reader';
import type { UsageEngineProcessPaths } from './process';

export interface ResolveUsageEngineProcessPathsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly systemTemporaryRoot?: string;
}

export const resolveUsageEngineProcessPaths = (
  options: ResolveUsageEngineProcessPathsOptions = {},
): UsageEngineProcessPaths => {
  const paths = resolveUsageRuntimePaths({
    cwd: options.cwd,
    databasePathForHome: usageStorePath,
    env: options.env,
    systemTemporaryRoot: options.systemTemporaryRoot,
  });
  return {
    configCwd: paths.configCwd,
    databasePath: paths.databasePath,
    homeDirectory: paths.homeDirectory,
    inboxDirectory: paths.inboxDirectory,
    operatorCwd: paths.operatorCwd,
    stateDirectory: paths.stateDirectory,
    temporaryRoot: paths.temporaryRoot,
  };
};
