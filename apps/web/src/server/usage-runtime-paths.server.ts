import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';
import { usageStorePath } from '@ai-usage/usage-store/reader';

export interface UsageWebRuntimePaths {
  readonly configCwd: string;
  readonly databasePath: string;
  readonly inboxDirectory: string;
  readonly rendezvousPath: string;
  readonly stateDirectory: string;
}

export interface ResolveUsageWebRuntimePathsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly systemHome?: string;
}

export const resolveUsageWebRuntimePaths = (options: ResolveUsageWebRuntimePathsOptions = {}): UsageWebRuntimePaths => {
  const paths = resolveUsageRuntimePaths({
    cwd: options.cwd,
    databasePathForHome: usageStorePath,
    env: options.env,
    systemHome: options.systemHome,
  });
  return {
    configCwd: paths.configCwd,
    databasePath: paths.databasePath,
    inboxDirectory: paths.inboxDirectory,
    rendezvousPath: paths.rendezvousPath,
    stateDirectory: paths.stateDirectory,
  };
};
