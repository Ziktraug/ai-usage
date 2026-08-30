import { startPostgresCluster } from './pg-harness';

const forceStopAfterMs = 3000;

const connectedEnvironment = (databaseUrl: string): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('AI_USAGE_PLATFORM_')) {
      environment[key] = value;
    }
  }
  environment.AI_USAGE_PLATFORM_DATABASE_TLS = 'disable';
  environment.AI_USAGE_PLATFORM_DATABASE_URL = databaseUrl;
  environment.AI_USAGE_PLATFORM_BASE_URL = 'http://127.0.0.1:4318';
  environment.AI_USAGE_PLATFORM_MIGRATION_MODE = 'apply';
  environment.NODE_ENV = 'development';
  return environment;
};

export const runConnectedDevelopmentServer = async (): Promise<number> => {
  const cluster = await startPostgresCluster('connected-development');
  const child = Bun.spawn(['bun', 'run', 'dev:server'], {
    cwd: process.cwd(),
    env: connectedEnvironment(cluster.url),
    stderr: 'inherit',
    stdout: 'inherit',
  });
  let stopping = false;
  let forceStopTimer: Timer | undefined;
  const stop = (): void => {
    if (stopping || child.exitCode !== null) {
      return;
    }
    stopping = true;
    child.kill('SIGTERM');
    forceStopTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, forceStopAfterMs);
    forceStopTimer.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    return await child.exited;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    stop();
    if (child.exitCode === null) {
      await child.exited;
    }
    if (forceStopTimer) {
      clearTimeout(forceStopTimer);
    }
    await cluster.stop();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await runConnectedDevelopmentServer();
  } catch {
    process.stderr.write('{"component":"connected-development","code":"startup-failed"}\n');
    process.exitCode = 1;
  }
}
