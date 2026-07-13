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
    [
      'focused-report-query-runner.ts',
      'known-project-sources-runner.ts',
      'report-payload-runner.ts',
      'session-query-materialize-runner.ts',
      'session-query-runner.ts',
    ].map((file) => writeFile(path.join(fixtureRoot, 'packages/report-data/src', file), 'export {};\n')),
  );
  return fixtureRoot;
};

describe('report runtime path resolution', () => {
  test('discovers the workspace from the repository root and apps/web', () => {
    const fromRoot = resolveReportRuntimePaths({ cwd: repositoryRoot });
    const fromWeb = resolveReportRuntimePaths({ cwd: path.join(repositoryRoot, 'apps/web') });

    expect(fromRoot).toEqual({
      focusedReportQueryRunner: path.join(repositoryRoot, 'packages/report-data/src/focused-report-query-runner.ts'),
      knownProjectSourcesRunner: path.join(repositoryRoot, 'packages/report-data/src/known-project-sources-runner.ts'),
      rootDir: repositoryRoot,
      reportingPayloadRunner: path.join(repositoryRoot, 'packages/report-data/src/report-payload-runner.ts'),
      rootEnvPath: path.join(repositoryRoot, '.env'),
      sessionQueryMaterializeRunner: path.join(
        repositoryRoot,
        'packages/report-data/src/session-query-materialize-runner.ts',
      ),
      sessionQueryRunner: path.join(repositoryRoot, 'packages/report-data/src/session-query-runner.ts'),
    });
    expect(fromWeb).toEqual(fromRoot);
  });

  test('resolves relative and absolute configured roots before walking upward', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      const fixtureParent = path.dirname(fixtureRoot);
      const relativeRoot = path.basename(fixtureRoot);
      const expected = {
        focusedReportQueryRunner: path.join(fixtureRoot, 'packages/report-data/src/focused-report-query-runner.ts'),
        knownProjectSourcesRunner: path.join(fixtureRoot, 'packages/report-data/src/known-project-sources-runner.ts'),
        rootDir: fixtureRoot,
        reportingPayloadRunner: path.join(fixtureRoot, 'packages/report-data/src/report-payload-runner.ts'),
        rootEnvPath: path.join(fixtureRoot, '.env'),
        sessionQueryMaterializeRunner: path.join(
          fixtureRoot,
          'packages/report-data/src/session-query-materialize-runner.ts',
        ),
        sessionQueryRunner: path.join(fixtureRoot, 'packages/report-data/src/session-query-runner.ts'),
      };

      expect(resolveReportRuntimePaths({ cwd: fixtureParent, configuredRoot: relativeRoot })).toEqual(expected);
      expect(resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toEqual(expected);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects configured roots that are invalid or missing the regular runner file', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    const missingRoot = path.join(fixtureRoot, 'missing');
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/report-payload-runner.ts'));

      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: missingRoot })).toThrow(
        missingRoot,
      );
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/report-payload-runner.ts'),
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

  test('rejects a configured root missing the session query runner', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/session-query-runner.ts'));
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/session-query-runner.ts'),
      );
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('rejects a configured root missing the focused report query runner', async () => {
    const fixtureRoot = await createWorkspaceFixture();
    try {
      await rm(path.join(fixtureRoot, 'packages/report-data/src/focused-report-query-runner.ts'));
      expect(() => resolveReportRuntimePaths({ cwd: repositoryRoot, configuredRoot: fixtureRoot })).toThrow(
        path.join(fixtureRoot, 'packages/report-data/src/focused-report-query-runner.ts'),
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
