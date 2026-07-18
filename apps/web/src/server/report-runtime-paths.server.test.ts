import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

const repositoryRoot = path.resolve(import.meta.dir, '../../../..');

const createWorkspaceFixture = async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-runtime-paths-'));
  await mkdir(path.join(fixtureRoot, 'packages/report-data/src'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'package.json'), '{"workspaces":["packages/*"]}\n');
  await Promise.all(
    ['known-project-sources-runner.ts', 'revision-query-runner.ts', 'session-query-materialize-runner.ts'].map((file) =>
      writeFile(path.join(fixtureRoot, 'packages/report-data/src', file), 'export {};\n'),
    ),
  );
  return fixtureRoot;
};

describe('report runtime path resolution', () => {
  test('discovers the workspace from the repository root and apps/web', () => {
    const fromRoot = resolveReportRuntimePaths({ cwd: repositoryRoot });
    const fromWeb = resolveReportRuntimePaths({ cwd: path.join(repositoryRoot, 'apps/web') });

    expect(fromRoot).toEqual({
      knownProjectSourcesRunner: path.join(repositoryRoot, 'packages/report-data/src/known-project-sources-runner.ts'),
      rootDir: repositoryRoot,
      rootEnvPath: path.join(repositoryRoot, '.env'),
      revisionQueryRunner: path.join(repositoryRoot, 'packages/report-data/src/revision-query-runner.ts'),
      sessionQueryMaterializeRunner: path.join(
        repositoryRoot,
        'packages/report-data/src/session-query-materialize-runner.ts',
      ),
    });
    expect(fromWeb).toEqual(fromRoot);
  });

  test('resolves relative and absolute configured roots before walking upward', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      const fixtureParent = path.dirname(fixtureRoot);
      const relativeRoot = path.basename(fixtureRoot);
      const expected = {
        knownProjectSourcesRunner: path.join(fixtureRoot, 'packages/report-data/src/known-project-sources-runner.ts'),
        rootDir: fixtureRoot,
        rootEnvPath: path.join(fixtureRoot, '.env'),
        revisionQueryRunner: path.join(fixtureRoot, 'packages/report-data/src/revision-query-runner.ts'),
        sessionQueryMaterializeRunner: path.join(
          fixtureRoot,
          'packages/report-data/src/session-query-materialize-runner.ts',
        ),
      };

      expect(resolveReportRuntimePaths({ cwd: fixtureParent, configuredRoot: relativeRoot })).toEqual(expected);
      expect(resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toEqual(expected);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects configured roots that are invalid or missing a required runner file', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    const missingRoot = path.join(fixtureRoot, 'missing');
    try {
      await rm(path.join(fixtureRoot, 'package.json'));

      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: missingRoot })).toThrow(
        missingRoot,
      );
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'package.json'),
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects a configured root missing the known project-source runner', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/known-project-sources-runner.ts'));
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/known-project-sources-runner.ts'),
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects a configured root missing the revision query runner', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/revision-query-runner.ts'));
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/revision-query-runner.ts'),
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects a configured root missing the session query materializer', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/session-query-materialize-runner.ts'));
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/session-query-materialize-runner.ts'),
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('ignores bundle-like paths and only walks from the supplied cwd', () => {
    const bundleLikePath = path.join(repositoryRoot, 'apps/web/.output/server/_ssr');
    const resolved = resolveReportRuntimePaths({ cwd: bundleLikePath });

    expect(resolved.rootDir).toBe(repositoryRoot);
  });
});
