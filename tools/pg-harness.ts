import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const COMMAND_OUTPUT_LIMIT = 4096;
const POSTGRES_START_ATTEMPTS = 2;
const POSTGRES_START_TIMEOUT_SECONDS = 15;
const POSTGRES_STOP_TIMEOUT_SECONDS = 15;

export type PostgresHarnessFailureCode = 'binary-missing' | 'initialization-failed' | 'start-failed' | 'stop-failed';

export class PostgresHarnessError extends Error {
  readonly code: PostgresHarnessFailureCode;
  readonly detail: string | null;

  constructor(code: PostgresHarnessFailureCode, detail: string | null = null, options?: ErrorOptions) {
    super(`Disposable PostgreSQL harness failed (${code}).`, options);
    this.name = 'PostgresHarnessError';
    this.code = code;
    this.detail = detail;
  }
}

export interface PostgresCluster {
  readonly dataDir: string;
  readonly logPath: string;
  readonly rootDir: string;
  readonly socketDir: string;
  readonly startupDurationMs: number;
  readonly stop: () => Promise<void>;
  readonly url: string;
}

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

const boundedOutput = (value: string): string => value.trim().slice(0, COMMAND_OUTPUT_LIMIT);

const resolveBinary = (name: 'initdb' | 'pg_ctl'): string => {
  const resolved = Bun.which(name);
  if (!resolved) {
    throw new PostgresHarnessError('binary-missing', `PostgreSQL 17 binary '${name}' is unavailable.`);
  }
  return resolved;
};

const runCommand = async (
  command: readonly string[],
  failureCode: Exclude<PostgresHarnessFailureCode, 'binary-missing'>,
): Promise<CommandResult> => {
  const child = Bun.spawn({
    cmd: [...command],
    env: { ...process.env, LC_ALL: 'C' },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new PostgresHarnessError(failureCode, boundedOutput(stderr || stdout));
  }
  return { stderr: boundedOutput(stderr), stdout: boundedOutput(stdout) };
};

const normalizeLabel = (label: string): string => {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 48) || 'test';
};

const configString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const clusterUrl = (socketDir: string): string => {
  const url = new URL('postgresql://postgres@localhost/postgres');
  url.searchParams.set('host', socketDir);
  return url.toString();
};

export const retryPostgresStart = async <Result>(attempt: () => Promise<Result>): Promise<Result> => {
  for (let attemptIndex = 0; attemptIndex < POSTGRES_START_ATTEMPTS; attemptIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      const canRetry =
        attemptIndex + 1 < POSTGRES_START_ATTEMPTS &&
        error instanceof PostgresHarnessError &&
        error.code === 'start-failed';
      if (!canRetry) {
        throw error;
      }
    }
  }
  throw new PostgresHarnessError('start-failed', 'PostgreSQL start retry policy exhausted unexpectedly.');
};

const startPostgresClusterAttempt = async (label: string): Promise<PostgresCluster> => {
  const startedAt = performance.now();
  const initdb = resolveBinary('initdb');
  const pgCtl = resolveBinary('pg_ctl');
  const rootDir = await mkdtemp(path.join(tmpdir(), `ai-usage-pg-${normalizeLabel(label)}-`));
  const dataDir = path.join(rootDir, 'data');
  const socketDir = path.join(rootDir, 'socket');
  const logPath = path.join(rootDir, 'postgres.log');
  const keepOnFailure = process.env.AI_USAGE_PG_HARNESS_KEEP_ON_FAILURE === '1';
  let clusterInitialized = false;

  await Promise.all([chmod(rootDir, 0o700), mkdir(socketDir, { mode: 0o700 })]);

  try {
    await runCommand(
      [
        initdb,
        '--pgdata',
        dataDir,
        '--username=postgres',
        '--encoding=UTF8',
        '--locale=C',
        '--auth=trust',
        '--no-sync',
      ],
      'initialization-failed',
    );
    clusterInitialized = true;
    await appendFile(
      path.join(dataDir, 'postgresql.conf'),
      [
        '',
        "listen_addresses = ''",
        `unix_socket_directories = ${configString(socketDir)}`,
        'unix_socket_permissions = 0700',
        'fsync = off',
        'synchronous_commit = off',
        'full_page_writes = off',
        'max_connections = 32',
        '',
      ].join('\n'),
      'utf8',
    );
    await runCommand(
      [
        pgCtl,
        '--pgdata',
        dataDir,
        '--log',
        logPath,
        '--wait',
        '--timeout',
        String(POSTGRES_START_TIMEOUT_SECONDS),
        'start',
      ],
      'start-failed',
    );
  } catch (error) {
    if (clusterInitialized) {
      await runCommand(
        [
          pgCtl,
          '--pgdata',
          dataDir,
          '--mode=immediate',
          '--wait',
          '--timeout',
          String(POSTGRES_STOP_TIMEOUT_SECONDS),
          'stop',
        ],
        'stop-failed',
      ).catch(() => undefined);
    }
    const serverLog =
      error instanceof PostgresHarnessError && error.code === 'start-failed'
        ? await readFile(logPath, 'utf8').catch(() => '')
        : '';
    const reportedError =
      serverLog && error instanceof PostgresHarnessError
        ? new PostgresHarnessError(
            'start-failed',
            boundedOutput([error.detail, serverLog].filter(Boolean).join('\n')),
            {
              cause: error,
            },
          )
        : error;
    if (!keepOnFailure) {
      await rm(rootDir, { force: true, recursive: true });
    }
    throw reportedError;
  }

  let stopOperation: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopOperation ??= (async () => {
      let stopFailure: unknown;
      try {
        await runCommand(
          [
            pgCtl,
            '--pgdata',
            dataDir,
            '--mode=fast',
            '--wait',
            '--timeout',
            String(POSTGRES_STOP_TIMEOUT_SECONDS),
            'stop',
          ],
          'stop-failed',
        );
      } catch (error) {
        stopFailure = error;
        try {
          await runCommand(
            [
              pgCtl,
              '--pgdata',
              dataDir,
              '--mode=immediate',
              '--wait',
              '--timeout',
              String(POSTGRES_STOP_TIMEOUT_SECONDS),
              'stop',
            ],
            'stop-failed',
          );
          stopFailure = undefined;
        } catch {
          // Preserve the first typed failure after both bounded stop modes fail.
        }
      }
      if (!stopFailure) {
        await rm(rootDir, { force: true, recursive: true });
      }
      if (stopFailure) {
        throw stopFailure;
      }
    })();
    return stopOperation;
  };

  return {
    dataDir,
    logPath,
    rootDir,
    socketDir,
    startupDurationMs: performance.now() - startedAt,
    stop,
    url: clusterUrl(socketDir),
  };
};

export const startPostgresCluster = (label: string): Promise<PostgresCluster> =>
  retryPostgresStart(() => startPostgresClusterAttempt(label));
