import os from 'node:os';
import path from 'node:path';
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

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

const optionalAbsolutePath = (value: string | undefined, fallback: string, label: string): string =>
  absolutePath(value ?? fallback, label);

export const resolveCliUsagePaths = (options: ResolveCliUsagePathsOptions = {}): CliUsagePaths => {
  const env = options.env ?? process.env;
  const operatorCwd = absolutePath(options.cwd ?? process.cwd(), 'CLI working directory');
  const homeDirectory = optionalAbsolutePath(env.AI_USAGE_HOME ?? env.HOME, os.homedir(), 'CLI home directory');
  const stateDirectory = optionalAbsolutePath(
    env.AI_USAGE_ENGINE_STATE_DIR,
    path.join(homeDirectory, '.config', 'ai-usage', 'engine'),
    'CLI engine state directory',
  );
  return {
    configCwd: optionalAbsolutePath(env.AI_USAGE_ROOT_DIR, operatorCwd, 'CLI config root'),
    databasePath: optionalAbsolutePath(env.AI_USAGE_DATABASE_PATH, usageStorePath(homeDirectory), 'CLI database path'),
    homeDirectory,
    operatorCwd,
    stateDirectory,
    temporaryRoot: optionalAbsolutePath(
      env.AI_USAGE_TEMP_ROOT,
      options.systemTemporaryRoot ?? os.tmpdir(),
      'CLI temporary root',
    ),
  };
};
