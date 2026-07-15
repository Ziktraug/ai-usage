import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import { createUsageSnapshot, type UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importPeerMergeBundle, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import {
  collectProjectedLocalReportRowsWithWarnings,
  createKnownLocalProjectSources,
  createLocalReportPayload,
  createLocalUsageSnapshot,
  createMergedUsageReport,
  createStoredReportPayload,
  listProjectSources,
  listProjectSourcesWithWarnings,
  parseGitConfigRemote,
  readStoredReportSourceFingerprint,
} from './index';

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

const writeCodexQuotaSession = (home: string) => {
  const codexDir = path.join(home, '.codex/sessions/2026');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    path.join(codexDir, 'quota.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          plan_type: 'pro',
          primary: { used_percent: 70, window_minutes: 300, resets_at: 1_767_242_800 },
        },
      },
    })}\n`,
  );
};

const writeInvalidOpenCodeDb = (home: string) => {
  const dbPath = path.join(home, '.local/share/opencode/opencode.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database');
};

const writeAiUsageConfig = (home: string, config: unknown) => {
  const configPath = path.join(home, '.config/ai-usage/config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

const cursorCsv = (rows: string[]) =>
  [
    'Date,User,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    ...rows,
  ].join('\n');

const makeSourcedRow = (input: {
  project: string;
  sourcePath: string;
  sessionId: string;
  parentSessionId?: string;
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
    ...(input.parentSessionId === undefined ? {} : { parentSourceSessionId: input.parentSessionId }),
    sourcePath: input.sourcePath,
  },
});

describe('shared reporting', () => {
  test('discovers project sources from local rows only and collects once when only imported rows are stored', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-known-local-projects-'));
    const localProjectPath = mkdtempSync(path.join(tmpdir(), 'ai-usage-known-local-project-'));
    try {
      const storage = createLocalHistoryStorage(home);
      writeClaudeSession(home, localProjectPath);
      await Effect.runPromise(
        writeMachineConfig(testMachine).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/peer/project', sessionId: 'peer-session' })],
          }),
        }),
      );

      const result = await Effect.runPromise(
        createKnownLocalProjectSources({ harness: 'claude', includeCursor: false }).pipe(
          Effect.provideService(LocalHistoryStorage, storage),
        ),
      );

      expect(result.sources).toEqual([
        expect.objectContaining({
          machineId: testMachine.id,
          machine: testMachine.label,
          project: path.basename(localProjectPath),
          sessions: 1,
          sourcePath: localProjectPath,
        }),
      ]);
      expect(result.projectGroups).toHaveLength(1);
      expect(result.projectGroups[0]?.sources).toEqual([
        expect.objectContaining({
          machineId: testMachine.id,
          sourcePath: localProjectPath,
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain('peer-machine');
      expect(JSON.stringify(result)).not.toContain('/peer/project');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(localProjectPath, { recursive: true, force: true });
    }
  });

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

  test('transports cursor-compatible datasets and local Codex provider status', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-datasets-'));
    try {
      const storage = createLocalHistoryStorage(home);
      writeCodexQuotaSession(home);
      await Effect.runPromise(
        writeMachineConfig(testMachine).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: null,
          includeCursor: false,
          keepSource: true,
          includeFacets: true,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(payload.datasets?.providerStatus?.providers[0]).toMatchObject({
        key: 'codex',
        machineId: 'machine-1',
        machineLabel: 'Test Machine',
        plan: 'pro',
      });
      expect(payload.facets?.providerStatus).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps orphaned Cursor CSV imports unassigned instead of treating the export file as a project', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-cursor-csv-'));
    try {
      const artifactPath = path.join(home, 'cursor-usage.csv');
      writeFileSync(
        artifactPath,
        cursorCsv([
          '"2026-06-03T12:00:00.000Z","alex@example.com","","","On-Demand","claude-4.5-sonnet","No","0","7","50","3","60","0.40"',
        ]),
      );
      writeAiUsageConfig(home, {
        cursor: { clusterGapMs: 5 * 60_000, usageExportPaths: [artifactPath], user: 'alex@example.com' },
      });

      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: 'cursor',
          includeCursor: true,
          keepSource: true,
          generatedAt: new Date('2026-06-04T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(payload.rows).toHaveLength(1);
      expect(payload.rows[0]?.source?.artifactPath).toBe(artifactPath);
      expect(payload.rows[0]?.source?.sourcePath).toBeUndefined();
      expect(payload.rows[0]?.rawProject).toBe('');
      expect(payload.rows[0]?.project.startsWith('(unknown)')).toBe(true);
      expect(payload.rows[0]?.project).not.toContain('cursor-usage.csv');
      expect(payload.projectGroups?.[0]?.sources[0]).toMatchObject({
        project: '(unknown)',
        sourcePath: '',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses overlapping project groups before building the report projection', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-overlapping-groups-'));
    try {
      writeAiUsageConfig(home, {
        projectGroups: [
          {
            id: 'group-1',
            name: 'broad',
            sources: [{ machineId: 'machine-a', project: 'Exalibur' }],
          },
          {
            id: 'group-2',
            name: 'precise',
            sources: [{ machineId: 'machine-a', sourcePath: '/work/exalibur' }],
          },
        ],
      });

      await expect(
        Effect.runPromise(
          createLocalReportPayload({
            harness: null,
            includeCursor: false,
            keepSource: true,
            options: defaultOptions,
          }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
        ),
      ).rejects.toThrow('Invalid ai-usage config');
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

  test('includes stored peer rows when creating the local report payload', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-peer-store-'));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        throw new Error('Report rendering must not perform network work');
      }) as unknown as typeof fetch;
      const storage = createLocalHistoryStorage(home);
      writeClaudeSession(home, '/work/local');
      await Effect.runPromise(
        writeMachineConfig(testMachine).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [
              makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-parent' }),
              makeSourcedRow({
                project: 'peer-project',
                sourcePath: '/work/peer',
                sessionId: 'peer-child',
                parentSessionId: 'peer-parent',
              }),
            ],
          }),
        }),
      );

      const payload = await Effect.runPromise(
        createLocalReportPayload({
          harness: null,
          includeCursor: false,
          keepSource: true,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(payload.rows).toHaveLength(3);
      expect(payload.rows.map((row) => row.project).sort()).toContain('peer-project · Peer Machine');
      expect(payload.rows.find((row) => row.rawProject === 'peer-project')?.source?.machineLabel).toBe('Peer Machine');
      expect(payload.rows.find((row) => row.name === 'peer-child')?.source?.rootSourceSessionId).toBe('peer-parent');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('creates a report payload from stored rows without collecting local history', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-stored-'));
    try {
      const storage = createLocalHistoryStorage(home);
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [
              makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-parent' }),
              makeSourcedRow({
                project: 'peer-project',
                sourcePath: '/work/peer',
                sessionId: 'peer-child',
                parentSessionId: 'peer-parent',
              }),
            ],
          }),
        }),
      );

      const payload = await Effect.runPromise(
        createStoredReportPayload({
          harness: null,
          includeCursor: false,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(payload.rows).toHaveLength(2);
      expect(payload.rows[0]?.project).toBe('peer-project · Peer Machine');
      expect(payload.rows[0]?.rawProject).toBe('peer-project');
      expect(payload.rows[0]?.source?.machineLabel).toBe('Peer Machine');
      expect(payload.rows.find((row) => row.name === 'peer-child')?.source?.rootSourceSessionId).toBe('peer-parent');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fingerprints the exact stored generation and semantic merged config', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-report-source-fingerprint-'));
    try {
      const storage = createLocalHistoryStorage(home);
      const readFingerprint = () =>
        Effect.runPromise(
          readStoredReportSourceFingerprint({}).pipe(Effect.provideService(LocalHistoryStorage, storage)),
        );
      writeAiUsageConfig(home, {
        projectAliases: [{ match: ['/work/raw'], name: 'Raw Project' }],
        projectGroups: [],
      });
      const initial = await readFingerprint();

      writeAiUsageConfig(home, {
        projectGroups: [],
        projectAliases: [{ name: 'Raw Project', match: ['/work/raw'] }],
      });
      expect(await readFingerprint()).toEqual(initial);

      writeAiUsageConfig(home, {
        projectAliases: [{ match: ['/work/raw'], name: 'Renamed Project' }],
        projectGroups: [],
      });
      const configChanged = await readFingerprint();
      expect(configChanged.configFingerprint).not.toBe(initial.configFingerprint);
      expect(configChanged.usageStoreGeneration).toBe(initial.usageStoreGeneration);

      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-session' })],
          }),
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
        }),
      );
      const storeChanged = await readFingerprint();
      expect(storeChanged.configFingerprint).toBe(configChanged.configFingerprint);
      expect(storeChanged.usageStoreGeneration).toBe(configChanged.usageStoreGeneration + 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('surfaces provider status from remote snapshots when local rows are excluded', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-remote-status-'));
    try {
      const remoteStatus = createProviderStatusDataset(
        [
          {
            key: 'codex',
            label: 'Codex',
            generatedAt: '2026-01-01T00:00:00.000Z',
            machineId: 'peer-machine',
            machineLabel: 'Peer Machine',
            source: 'local-history',
            state: 'ok',
            windows: [],
          },
        ],
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const snapshot = createUsageSnapshot({
        machine: { id: 'peer-machine', label: 'Peer Machine' },
        rows: [makeSourcedRow({ project: 'peer-project', sourcePath: '/work/peer', sessionId: 'peer-parent' })],
        datasets: { providerStatus: remoteStatus },
      });

      const result = await Effect.runPromise(
        createMergedUsageReport({
          harness: null,
          includeCursor: false,
          includeFacets: true,
          includeLocal: false,
          snapshots: [snapshot],
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(result.payload.datasets?.providerStatus?.providers[0]).toMatchObject({
        key: 'codex',
        machineId: 'peer-machine',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('projects configured project groups as native report projects', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-project-groups-'));
    try {
      const storage = createLocalHistoryStorage(home);
      writeAiUsageConfig(home, {
        projectGroups: [
          {
            id: 'exalibur',
            name: 'exalibur',
            sources: [
              { machineId: 'peer-a', sourcePath: '/work/exalibur' },
              { machineId: 'peer-a', sourcePath: '/work/exalibur2' },
              { machineId: 'peer-b', sourcePath: '/Users/nathan/exalibur' },
              { machineId: 'peer-b', sourcePath: '/missing/exalibur3' },
            ],
          },
        ],
      });
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-a', label: 'Machine A' },
            rows: [
              makeSourcedRow({ project: 'exalibur', sourcePath: '/work/exalibur', sessionId: 'a-exalibur' }),
              makeSourcedRow({ project: 'exalibur2', sourcePath: '/work/exalibur2', sessionId: 'a-exalibur2' }),
            ],
          }),
        }),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-b', label: 'Machine B' },
            rows: [
              makeSourcedRow({
                project: 'exalibur',
                sourcePath: '/Users/nathan/exalibur',
                sessionId: 'b-exalibur',
              }),
            ],
          }),
        }),
      );

      const payload = await Effect.runPromise(
        createStoredReportPayload({
          harness: null,
          includeCursor: false,
          includeFacets: true,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          options: defaultOptions,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(payload.rows).toHaveLength(3);
      expect(payload.rows.every((row) => row.project === 'exalibur')).toBe(true);
      expect(payload.rows.map((row) => row.rawProject).sort()).toEqual(['exalibur', 'exalibur', 'exalibur2']);
      expect(payload.projectGroups?.find((group) => group.id === 'group:exalibur')).toMatchObject({
        grouped: true,
        name: 'exalibur',
        sessions: 3,
      });
      expect(payload.projectGroups?.find((group) => group.id === 'group:exalibur')?.sources).toHaveLength(3);
      expect(payload.projectGroupConfigs?.[0]?.name).toBe('exalibur');
      expect(payload.warnings?.find((warning) => warning.reason === 'partial-group')).toMatchObject({
        groupId: 'exalibur',
        operation: 'projectGrouping',
        selectors: [{ machineId: 'peer-b', sourcePath: '/missing/exalibur3' }],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps portable Claude worktree-looking paths opaque', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-worktree-home-'));
    try {
      const parentPath = '/Users/nathan/projects/github/Exalibur2';
      const snapshot = createUsageSnapshot({
        machine: testMachine,
        rows: [
          makeSourcedRow({
            project: 'agent-a15e8356ff54ade2a',
            sourcePath: `${parentPath}/.claude/worktrees/agent-a15e8356ff54ade2a`,
            sessionId: 'agent-session-1',
          }),
          makeSourcedRow({
            project: 'agent-a2017811a25de4a7c',
            sourcePath: `${parentPath}/.claude/worktrees/agent-a2017811a25de4a7c`,
            sessionId: 'agent-session-2',
          }),
        ],
      });

      const merged = await Effect.runPromise(
        createMergedUsageReport({
          snapshots: [snapshot],
          includeLocal: false,
          harness: null,
          includeCursor: false,
          options: defaultOptions,
          generatedAt: new Date('2026-01-03T00:00:00.000Z'),
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(merged.rows).toHaveLength(2);
      expect(merged.rows.map((row) => row.project).sort()).toEqual([
        'agent-a15e8356ff54ade2a · Test Machine',
        'agent-a2017811a25de4a7c · Test Machine',
      ]);
      expect(merged.rows.map((row) => row.rawProject).sort()).toEqual([
        'agent-a15e8356ff54ade2a',
        'agent-a2017811a25de4a7c',
      ]);
      expect(merged.payload.projectGroups).toHaveLength(2);
      expect(merged.payload.projectGroups?.map((group) => group.sources[0]?.sourcePath).sort()).toEqual([
        `${parentPath}/.claude/worktrees/agent-a15e8356ff54ade2a`,
        `${parentPath}/.claude/worktrees/agent-a2017811a25de4a7c`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('projects configured project groups through the CLI projected-row API', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-projected-rows-'));
    const configCwd = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-projected-config-'));
    try {
      const storage = createLocalHistoryStorage(home);
      writeAiUsageConfig(home, {
        projectGroups: [
          {
            id: 'exalibur',
            name: 'exalibur',
            sources: [
              { machineId: 'peer-a', sourcePath: '/work/exalibur' },
              { machineId: 'peer-a', sourcePath: '/work/exalibur2' },
              { machineId: 'peer-b', sourcePath: '/Users/nathan/exalibur' },
              { machineId: 'peer-b', sourcePath: '/missing/exalibur3' },
            ],
          },
        ],
      });
      writeFileSync(
        path.join(configCwd, 'ai-usage.config.ts'),
        `export default { cursor: { usageExportDir: './cursor-exports' } }`,
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-a', label: 'Machine A' },
            rows: [
              makeSourcedRow({ project: 'exalibur', sourcePath: '/work/exalibur', sessionId: 'a-exalibur' }),
              makeSourcedRow({ project: 'exalibur2', sourcePath: '/work/exalibur2', sessionId: 'a-exalibur2' }),
            ],
          }),
        }),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          dbPath: usageStorePath(home),
          localMachineId: testMachine.id,
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-b', label: 'Machine B' },
            rows: [
              makeSourcedRow({
                project: 'exalibur',
                sourcePath: '/Users/nathan/exalibur',
                sessionId: 'b-exalibur',
              }),
            ],
          }),
        }),
      );

      const result = await Effect.runPromise(
        collectProjectedLocalReportRowsWithWarnings({
          harness: null,
          includeCursor: false,
          configCwd,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row) => row.project === 'exalibur')).toBe(true);
      expect(
        result.rows.some(
          (row) =>
            row.rawProject !== undefined && row.projectGroupId !== undefined && row.projectSourceId !== undefined,
        ),
      ).toBe(true);
      expect(
        result.warnings.find((warning) => 'reason' in warning && warning.reason === 'partial-group'),
      ).toMatchObject({
        groupId: 'exalibur',
        operation: 'projectGrouping',
        selectors: [{ machineId: 'peer-b', sourcePath: '/missing/exalibur3' }],
      });
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

  test('carries local collection warnings through snapshots, merge reports, and project sources', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-warning-'));
    try {
      writeInvalidOpenCodeDb(home);

      const storage = createLocalHistoryStorage(home);
      const snapshot = await Effect.runPromise(
        createLocalUsageSnapshot({
          harness: 'opencode',
          includeCursor: false,
          machine: testMachine,
          generatedAt: new Date('2026-01-02T00:00:00.000Z'),
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      const merged = await Effect.runPromise(
        createMergedUsageReport({
          snapshots: [],
          includeLocal: true,
          harness: 'opencode',
          includeCursor: false,
          machine: testMachine,
          options: defaultOptions,
          generatedAt: new Date('2026-01-03T00:00:00.000Z'),
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const projectSources = await Effect.runPromise(
        listProjectSourcesWithWarnings({
          snapshots: [],
          includeLocal: true,
          harness: 'opencode',
          includeCursor: false,
          machine: testMachine,
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(snapshot.rows).toHaveLength(0);
      expect(snapshot.warnings?.[0]?.harness).toBe('opencode');
      expect(snapshot.warnings?.[0]?.message).toContain('Failed to read OpenCode live database');
      expect(merged.payload.warnings?.[0]?.harness).toBe('opencode');
      expect(merged.payload.warnings?.[0]?.message).toContain('Failed to read OpenCode live database');
      expect(projectSources.sources).toHaveLength(0);
      expect(projectSources.warnings[0]?.harness).toBe('opencode');
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
        rows: [
          makeSourcedRow({ project: 'raw', sourcePath: '/work/raw', sessionId: 'session-1' }),
          makeSourcedRow({
            project: 'raw-child',
            sourcePath: '/work/raw',
            sessionId: 'session-2',
            parentSessionId: 'session-1',
          }),
        ],
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
          makeSourcedRow({
            project: 'raw-child-newer',
            sourcePath: '/work/raw',
            sessionId: 'session-2',
            parentSessionId: 'session-1',
            tokens: { in: 8, out: 4, cr: 0, cw: 0 },
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

      expect(merged.duplicatesDropped).toBe(2);
      expect(merged.warnings).toHaveLength(3);
      expect(merged.rows).toHaveLength(2);
      expect(merged.rows[0]?.project).toBe('Aliased Project');
      expect(merged.rows[0]?.rawProject).toBe('raw-newer');
      expect(merged.payload.rows[0]?.project).toBe('Aliased Project');
      expect(merged.payload.warnings?.some((warning) => warning.reason === 'legacy-alias')).toBe(true);
      expect(merged.rows.find((row) => row.name === 'session-2')?.source.rootSourceSessionId).toBe('session-1');
      expect(merged.payload.rows.find((row) => row.name === 'session-2')?.source?.rootSourceSessionId).toBe(
        'session-1',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configCwd, { recursive: true, force: true });
    }
  });

  test('treats snapshot source paths as opaque even when they name a local repository', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-sources-home-'));
    const projectPath = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-project-'));
    try {
      let gitReadCalls = 0;
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
          readGitFile: () => {
            gitReadCalls++;
            return '[remote "origin"]\n  url = git@github.com:owner/repo.git\n';
          },
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
          gitRemote: '',
          sessions: 2,
          tokens: 20,
        }),
      ]);
      expect(gitReadCalls).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('does not follow worktree metadata declared by a portable snapshot', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-git-worktree-home-'));
    const parentPath = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-parent-'));
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'ai-usage-reporting-worktree-'));
    try {
      const commonGitDir = path.join(parentPath, '.git');
      const worktreeGitDir = path.join(commonGitDir, 'worktrees/worktree');
      const snapshot = createUsageSnapshot({
        machine: testMachine,
        rows: [
          makeSourcedRow({
            project: path.basename(worktreePath),
            sourcePath: worktreePath,
            sessionId: 'worktree-session',
          }),
        ],
      });

      let gitReadCalls = 0;
      const sources = await Effect.runPromise(
        listProjectSources({
          snapshots: [snapshot],
          includeLocal: false,
          harness: null,
          includeCursor: false,
          includeGitRemote: true,
          readGitFile: (filePath) => {
            gitReadCalls++;
            if (filePath === path.join(worktreePath, '.git')) {
              return `gitdir: ${worktreeGitDir}\n`;
            }
            if (filePath === path.join(worktreeGitDir, 'commondir')) {
              return '../..\n';
            }
            if (filePath === path.join(commonGitDir, 'config')) {
              return '[remote "origin"]\n  url = git@github.com:owner/repo.git\n';
            }
            return null;
          },
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );

      expect(sources).toEqual([
        expect.objectContaining({
          project: path.basename(worktreePath),
          sourcePath: worktreePath,
          gitRemote: '',
          sessions: 1,
        }),
      ]);
      expect(gitReadCalls).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(parentPath, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test('parses the origin remote from git config text', () => {
    expect(
      parseGitConfigRemote(`
[core]
  repositoryformatversion = 0
[remote "upstream"]
  url = https://github.com/other/repo.git
[remote "origin"]
  fetch = +refs/heads/*:refs/remotes/origin/*
  url = https://github.com/owner/repo.git
`),
    ).toBe('owner/repo');
  });
});
