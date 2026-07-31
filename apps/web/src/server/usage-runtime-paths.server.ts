import os from 'node:os';
import path from 'node:path';
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

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

const optionalAbsolutePath = (value: string | undefined, fallback: string, label: string): string =>
  absolutePath(value ?? fallback, label);

export const resolveUsageWebRuntimePaths = (options: ResolveUsageWebRuntimePathsOptions = {}): UsageWebRuntimePaths => {
  const env = options.env ?? process.env;
  const cwd = absolutePath(options.cwd ?? process.cwd(), 'Usage web working directory');
  const homeDirectory = optionalAbsolutePath(
    env.AI_USAGE_HOME ?? env.HOME,
    options.systemHome ?? os.homedir(),
    'Usage web home directory',
  );
  const stateDirectory = optionalAbsolutePath(
    env.AI_USAGE_ENGINE_STATE_DIR,
    path.join(homeDirectory, '.config', 'ai-usage', 'engine'),
    'Usage engine state directory',
  );
  return {
    configCwd: optionalAbsolutePath(env.AI_USAGE_ROOT_DIR, cwd, 'Usage web config root'),
    databasePath: optionalAbsolutePath(
      env.AI_USAGE_DATABASE_PATH,
      usageStorePath(homeDirectory),
      'Usage database path',
    ),
    inboxDirectory: path.join(stateDirectory, 'inbox'),
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    stateDirectory,
  };
};
