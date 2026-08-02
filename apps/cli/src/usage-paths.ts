import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';
import { usageStorePath } from '@ai-usage/usage-store/reader';

export interface CliUsagePaths {
  readonly configCwd: string;
  readonly databasePath: string;
  readonly homeDirectory: string;
  readonly operatorCwd: string;
  readonly stateDirectory: string;
  readonly temporaryRoot: string;
}

export interface ResolveCliUsagePathsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly systemTemporaryRoot?: string;
}

export const resolveCliUsagePaths = (options: ResolveCliUsagePathsOptions = {}): CliUsagePaths => {
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
    operatorCwd: paths.operatorCwd,
    stateDirectory: paths.stateDirectory,
    temporaryRoot: paths.temporaryRoot,
  };
};
