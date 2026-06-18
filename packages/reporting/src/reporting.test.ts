import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createUsageSnapshot, type UsageMachine } from '@ai-usage/core/snapshot';
import type { SourcedRow } from '@ai-usage/core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/core/usage-row';
import { LocalHistoryStorage, createLocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { Effect } from 'effect';
import { createLocalReportPayload, createLocalUsageSnapshot, createMergedUsageReport, listProjectSources } from './index';

const defaultOptions = {
  since: null,
  project: null,
  limit: null,
  minTokens: 1,
  sort: 'date' as const,
};

const testMachine: UsageMachine = { id: 'machine-1', label: 'Test Machine' };

const writeClaudeSession = (home: string, projectPath = '/work/raw') => {
  const claudeDir = path.join(home, '.claude/projects/-work-raw');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    path.join(claudeDir, 'session-1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: projectPath,
      requestId: 'request-1',
      message: {
        id: 'message-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    })}\n`,
  );
};

const makeSourcedRow = (input: {
  project: string;
  sourcePath: string;
  sessionId: string;
  tokens?: { in: number; out: number; cr: number; cw: number };
}): SourcedRow => ({
  ...normalizeUsageRow({
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    provider: 'Claude API',
    name: input.sessionId,
    model: 'claude-sonnet-4-6',
    project: input.project,
    tokens: input.tokens ?? { in: 10, out: 5, cr: 0, cw: 0 },
    cost: approximateApiCost,
    calls: 1,
  }),
  source: {
    harnessKey: 'claude',
    sourceSessionId: input.sessionId,
    sourcePath: input.sourcePath,
  },
});

describe('shared reporting', () => {
  test('creates the compatibility payload through the shared local history boundary', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-'));
    try {
      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: null,
          includeCursor: false,
          keepSource: true,
          includeFacets: true,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(payload).toMatchObject({
        generatedAt: '2026-01-01T00:00:00.000Z',
        filters: {
          since: null,
          project: null,
          limit: null,
          minTokens: 1,
          sort: 'date',
        },
        rows: [],
        tableRows: [],
        omittedRows: 0,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('loads repo config from an explicit cwd', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-home-'));
    const configCwd = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-config-'));
    try {
      writeClaudeSession(home);
      writeFileSync(
        path.join(configCwd, 'ai-usage.config.ts'),
        `export default { projectAliases: [{ name: 'Aliased Project', match: ['/work/raw'] }] }`,
      );

      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: 'claude',
          includeCursor: false,
          keepSource: true,
          configCwd,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(payload.rows).toHaveLength(1);
      expect(payload.rows[0]?.project).toBe('Aliased Project');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configCwd, { recursive: true, force: true });
    }
  });

  test('creates local usage snapshots with machine provenance', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-snapshot-'));
    try {
      writeClaudeSession(home);

      const snapshot = await Effect.runPromise(
        createLocalUsageSnapshot({
          harness: 'claude',
          includeCursor: false,
          machine: testMachine,
          generatedAt: new Date('2026-01-02T00:00:00.000Z'),
          includeFacets: true,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(snapshot.generatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(snapshot.machine).toEqual(testMachine);
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0]?.source.machineId).toBe('machine-1');
      expect(snapshot.rows[0]?.source.machineLabel).toBe('Test Machine');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('merges snapshots, drops duplicates, and applies aliases after merge', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-merge-home-'));
    const configCwd = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-merge-config-'));
    try {
      writeFileSync(
        path.join(configCwd, 'ai-usage.config.ts'),
        `export default { projectAliases: [{ name: 'Aliased Project', match: ['/work/raw'] }] }`,
      );
      const older = createUsageSnapshot({
        machine: testMachine,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
        rows: [makeSourcedRow({ project: 'raw', sourcePath: '/work/raw', sessionId: 'session-1' })],
      });
      const newer = createUsageSnapshot({
        machine: testMachine,
        generatedAt: new Date('2026-01-02T00:00:00.000Z'),
        rows: [
          makeSourcedRow({
            project: 'raw-newer',
            sourcePath: '/work/raw',
            sessionId: 'session-1',
            tokens: { in: 20, out: 10, cr: 0, cw: 0 },
          }),
        ],
      });

      const merged = await Effect.runPromise(
        createMergedUsageReport({
          snapshots: [older, newer],
          includeLocal: false,
          harness: null,
          includeCursor: false,
          configCwd,
          options: defaultOptions,
          generatedAt: new Date('2026-01-03T00:00:00.000Z'),
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(merged.duplicatesDropped).toBe(1);
      expect(merged.warnings).toHaveLength(1);
      expect(merged.rows).toHaveLength(1);
      expect(merged.rows[0]?.project).toBe('Aliased Project');
      expect(merged.payload.rows[0]?.project).toBe('Aliased Project');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configCwd, { recursive: true, force: true });
    }
  });

  test('lists project sources from snapshots without reading real home', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-sources-home-'));
    const projectPath = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-project-'));
    try {
      mkdirSync(path.join(projectPath, '.git'), { recursive: true });
      writeFileSync(path.join(projectPath, '.git', 'config'), '[remote "origin"]\n  url = git@github.com:owner/repo.git\n');
      const snapshot = createUsageSnapshot({
        machine: testMachine,
        rows: [
          makeSourcedRow({ project: 'repo', sourcePath: projectPath, sessionId: 'session-1' }),
          makeSourcedRow({
            project: 'repo',
            sourcePath: projectPath,
            sessionId: 'session-2',
            tokens: { in: 4, out: 1, cr: 0, cw: 0 },
          }),
        ],
      });

      const sources = await Effect.runPromise(
        listProjectSources({
          snapshots: [snapshot],
          includeLocal: false,
          harness: null,
          includeCursor: false,
          includeGitRemote: true,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(sources).toEqual([
        expect.objectContaining({
          project: 'repo',
          machine: 'Test Machine',
          machineId: 'machine-1',
          harness: 'Claude Code',
          harnessKey: 'claude',
          sourcePath: projectPath,
          gitRemote: 'owner/repo',
          sessions: 2,
          tokens: 20,
        }),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
