import os from 'node:os';
import path from 'node:path';
import { usageStorePath } from '@ai-usage/usage-store/reader';
import type { UsageEngineProcessPaths } from './process';

export interface ResolveUsageEngineProcessPathsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly systemTemporaryRoot?: string;
}

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

const optionalAbsolutePath = (value: string | undefined, fallback: string, label: string): string =>
  absolutePath(value ?? fallback, label);

export const resolveUsageEngineProcessPaths = (
  options: ResolveUsageEngineProcessPathsOptions = {},
): UsageEngineProcessPaths => {
  const env = options.env ?? process.env;
  const cwd = absolutePath(options.cwd ?? process.cwd(), 'Usage engine working directory');
  const homeDirectory = optionalAbsolutePath(
    env.AI_USAGE_HOME ?? env.HOME,
    os.homedir(),
    'Usage engine home directory',
  );
  const stateDirectory = optionalAbsolutePath(
    env.AI_USAGE_ENGINE_STATE_DIR,
    path.join(homeDirectory, '.config', 'ai-usage', 'engine'),
    'Usage engine state directory',
  );
  return {
    configCwd: optionalAbsolutePath(env.AI_USAGE_ROOT_DIR, cwd, 'Usage engine config root'),
    databasePath: optionalAbsolutePath(
      env.AI_USAGE_DATABASE_PATH,
      usageStorePath(homeDirectory),
      'Usage engine database path',
    ),
    homeDirectory,
    inboxDirectory: path.join(stateDirectory, 'inbox'),
    operatorCwd: cwd,
    stateDirectory,
    temporaryRoot: optionalAbsolutePath(
      env.AI_USAGE_TEMP_ROOT,
      options.systemTemporaryRoot ?? os.tmpdir(),
      'Usage engine temporary root',
    ),
  };
};
