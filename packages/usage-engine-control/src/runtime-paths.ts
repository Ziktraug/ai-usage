import os from 'node:os';
import path from 'node:path';

export interface UsageRuntimePaths {
  readonly configCwd: string;
  readonly databasePath: string;
  readonly homeDirectory: string;
  readonly inboxDirectory: string;
  readonly operatorCwd: string;
  readonly rendezvousPath: string;
  readonly stateDirectory: string;
  readonly temporaryRoot: string;
}

export interface ResolveUsageRuntimePathsOptions {
  readonly cwd?: string | undefined;
  readonly databasePathForHome: (homeDirectory: string) => string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly systemHome?: string | undefined;
  readonly systemTemporaryRoot?: string | undefined;
}

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

const optionalAbsolutePath = (value: string | undefined, fallback: string, label: string): string =>
  absolutePath(value ?? fallback, label);

export const resolveUsageRuntimePaths = ({
  cwd = process.cwd(),
  databasePathForHome,
  env = process.env,
  systemHome = os.homedir(),
  systemTemporaryRoot = os.tmpdir(),
}: ResolveUsageRuntimePathsOptions): UsageRuntimePaths => {
  const operatorCwd = absolutePath(cwd, 'Usage runtime working directory');
  const homeDirectory = optionalAbsolutePath(env.AI_USAGE_HOME ?? env.HOME, systemHome, 'Usage home directory');
  const stateDirectory = optionalAbsolutePath(
    env.AI_USAGE_ENGINE_STATE_DIR,
    path.join(homeDirectory, '.config', 'ai-usage', 'engine'),
    'Usage engine state directory',
  );
  return {
    configCwd: optionalAbsolutePath(env.AI_USAGE_ROOT_DIR, operatorCwd, 'Usage config root'),
    databasePath: optionalAbsolutePath(
      env.AI_USAGE_DATABASE_PATH,
      databasePathForHome(homeDirectory),
      'Usage database path',
    ),
    homeDirectory,
    inboxDirectory: path.join(stateDirectory, 'inbox'),
    operatorCwd,
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    stateDirectory,
    temporaryRoot: optionalAbsolutePath(env.AI_USAGE_TEMP_ROOT, systemTemporaryRoot, 'Usage temporary root'),
  };
};
