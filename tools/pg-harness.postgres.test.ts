import { expect, test } from 'bun:test';
import { lstat } from 'node:fs/promises';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';

const queryCluster = async (socketDir: string): Promise<string> => {
  const psql = Bun.which('psql');
  if (!psql) {
    throw new Error('psql is unavailable in the PostgreSQL test environment.');
  }
  const child = Bun.spawn({
    cmd: [psql, '--no-psqlrc', '--tuples-only', '--no-align', '--command', 'select current_database()'],
    env: {
      ...process.env,
      PGDATABASE: 'postgres',
      PGHOST: socketDir,
      PGUSER: 'postgres',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`psql fixture query failed: ${stderr.trim()}`);
  }
  return stdout.trim();
};

if (runPostgresTests) {
  test('starts two isolated PostgreSQL 17 clusters and removes both roots idempotently', async () => {
    const clusters = await Promise.all([startPostgresCluster('isolation-a'), startPostgresCluster('isolation-b')]);
    try {
      expect(clusters[0]?.socketDir).not.toBe(clusters[1]?.socketDir);
      expect(await Promise.all(clusters.map(({ socketDir }) => queryCluster(socketDir)))).toEqual([
        'postgres',
        'postgres',
      ]);
      expect(clusters.every(({ startupDurationMs }) => startupDurationMs > 0)).toBe(true);
    } finally {
      await Promise.all(clusters.map(({ stop }) => stop()));
      await Promise.all(clusters.map(({ stop }) => stop()));
    }
    const removedRoots = await Promise.all(
      clusters.map(({ rootDir }) =>
        lstat(rootDir).then(
          () => 'present',
          (error: unknown) => (typeof error === 'object' && error !== null && 'code' in error ? error.code : 'unknown'),
        ),
      ),
    );
    expect(removedRoots).toEqual(['ENOENT', 'ENOENT']);
  }, 30_000);
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  test.skip('PostgreSQL 17 cluster isolation requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
}
