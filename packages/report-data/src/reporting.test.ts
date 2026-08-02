import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CursorCommitAttributionRow, NormalizedDatasetItem } from '@ai-usage/report-core/datasets';
import { createUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import { createProviderStatusDataset } from '@ai-usage/report-core/provider-status';
import { createUsageSnapshot, type UsageMachine } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import {
  importLocalRows,
  importNormalizedDatasetItems,
  importPeerMergeBundle,
  initializeUsageStore,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  assembleMergedUsageReport,
  collectProjectSourcesFromSnapshots,
  createStoredReportCapture,
  createStoredReportPayload,
  parseGitConfigRemote,
  readStoredCursorCommitAttribution,
  readStoredReportSourceFingerprint,
  toStoredReportPublicationCapture,
} from './index';

const defaultOptions = {
  limit: null,
  minTokens: 1,
  project: null,
  since: null,
  sort: 'date' as const,
};

const testMachine: UsageMachine = { id: 'machine-1', label: 'Test Machine' };

const cursorCommitAttributionItem = (
  machineId: string,
  payload: CursorCommitAttributionRow,
): NormalizedDatasetItem => ({
  datasetKey: 'cursor.commit-attribution',
  itemKey: createHash('sha256')
    .update(JSON.stringify([payload.commitHash, payload.branchName]))
    .digest('hex'),
  machineId,
  payload,
  schemaVersion: 1,
  sourceId: 'cursor.commit-attribution',
});

const makeSourcedRow = (input: {
  parentSessionId?: string;
  project: string;
  sessionId: string;
  sourcePath: string;
  tokens?: { cr: number; cw: number; in: number; out: number };
}): SourcedRow => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: approximateApiCost,
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    model: 'claude-sonnet-4-6',
    name: input.sessionId,
    project: input.project,
    provider: 'Claude API',
    tokens: input.tokens ?? { cr: 0, cw: 0, in: 10, out: 5 },
  }),
  source: {
    harnessKey: 'claude',
    ...(input.parentSessionId === undefined ? {} : { parentSourceSessionId: input.parentSessionId }),
    sourcePath: input.sourcePath,
    sourceSessionId: input.sessionId,
  },
});

describe('stored reporting', () => {
  test('keeps source authority aligned with filtered stored report rows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-reporting-authority-'));
    try {
      const dbPath = usageStorePath(home);
      await Effect.runPromise(
        importLocalRows({
          dbPath,
          importedAt: new Date('2026-01-01T10:00:00.000Z'),
          machine: testMachine,
          rows: [makeSourcedRow({ project: 'local-project', sessionId: 'local-session', sourcePath: '/work/local' })],
        }),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [makeSourcedRow({ project: 'peer-project', sessionId: 'peer-session', sourcePath: '/work/peer' })],
          }),
          dbPath,
          importedAt: new Date('2026-01-01T11:00:00.000Z'),
          localMachineId: testMachine.id,
        }),
      );

      const capture = await Effect.runPromise(
        createStoredReportCapture({
          config: {},
          dbPath,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          harness: null,
          includeCursor: false,
          machine: testMachine,
          options: defaultOptions,
        }),
      );

      expect(
        Object.fromEntries(
          capture.payload.rows.map((row, index) => [row.source?.sourceSessionId, capture.rowSourceAuthorities[index]]),
        ),
      ).toEqual({
        'local-session': 'local-observed',
        'peer-session': 'portable-opaque',
      });
      expect(Object.hasOwn(capture.payload, 'rowSourceAuthorities')).toBe(false);
      const publication = toStoredReportPublicationCapture(capture, 'c'.repeat(64));
      expect(publication.rows).toEqual(capture.payload.rows);
      expect(publication.sourceAuthorities).toEqual(capture.rowSourceAuthorities);
      expect(publication.support.machineFreshness).toEqual(capture.machineFreshness);
      expect(Object.hasOwn(publication.support, 'rows')).toBe(false);
      expect(Object.hasOwn(publication.support, 'tableRows')).toBe(false);
      expect(capture.machineFreshness.kind).toBe('available');
      if (capture.machineFreshness.kind !== 'available') {
        throw new Error('Stored report capture must include available machine freshness.');
      }
      expect(capture.machineFreshness.observedAt).toBe(capture.payload.generatedAt);
      expect(capture.machineFreshness.omittedMachines).toBe(0);
      expect(capture.machineFreshness.skippedRows).toBe(0);
      expect(
        Object.fromEntries(
          capture.machineFreshness.machines.map(({ id, label, lastSeenAt }) => [id, { label, lastSeenAt }]),
        ),
      ).toEqual({
        'peer-machine': { label: 'Peer Machine', lastSeenAt: '2026-01-01T11:00:00.000Z' },
        [testMachine.id]: { label: testMachine.label, lastSeenAt: '2026-01-01T10:00:00.000Z' },
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('reads an explicit engine database without creating home config', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-reporting-explicit-store-'));
    try {
      const dbPath = path.join(root, 'engine-state', 'usage.sqlite');
      await Effect.runPromise(importLocalRows({ dbPath, machine: testMachine, rows: [] }));

      const capture = await Effect.runPromise(
        createStoredReportCapture({
          config: {},
          dbPath,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          harness: null,
          includeCursor: false,
          machine: testMachine,
          options: defaultOptions,
        }),
      );
      const fingerprint = await Effect.runPromise(readStoredReportSourceFingerprint({ config: {}, dbPath }));

      expect(capture.payload.rows).toEqual([]);
      expect(fingerprint).toMatchObject({ machineFleetGeneration: 0, usageStoreGeneration: 0 });
      expect(Bun.file(path.join(root, '.config', 'ai-usage', 'machine.json')).size).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('round-trips Cursor attribution through normalized dataset storage', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-reporting-cursor-dataset-'));
    try {
      const dbPath = usageStorePath(root);
      const row: CursorCommitAttributionRow = {
        blankLinesAdded: 0,
        blankLinesDeleted: 0,
        branchName: 'main',
        commitDate: null,
        commitHash: 'abc123',
        commitMessage: 'Add source control',
        composerLinesAdded: 3,
        composerLinesDeleted: 0,
        humanLinesAdded: 2,
        humanLinesDeleted: 0,
        linesAdded: 5,
        linesDeleted: 0,
        scoredAt: '2026-07-16T10:00:00.000Z',
        tabLinesAdded: 0,
        tabLinesDeleted: 0,
        v1AiPercentage: 60,
        v2AiPercentage: 60,
      };

      expect(
        await Effect.runPromise(
          importNormalizedDatasetItems({ dbPath, items: [cursorCommitAttributionItem(testMachine.id, row)] }),
        ),
      ).toMatchObject({ inserted: 1, unchanged: 0, updated: 0 });
      const payload = await Effect.runPromise(
        createStoredReportPayload({
          config: {},
          dbPath,
          generatedAt: new Date('2026-07-16T11:00:00.000Z'),
          harness: null,
          includeCursor: true,
          includeFacets: true,
          machine: testMachine,
          options: defaultOptions,
        }),
      );

      expect(await Effect.runPromise(readStoredCursorCommitAttribution({ dbPath }))).toEqual({
        rows: [row],
        skipped: 0,
        truncated: false,
      });
      expect(payload.datasets?.cursorCommitAttribution).toEqual([row]);
      expect(payload.warnings ?? []).toHaveLength(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('creates a report payload from stored rows without collecting local history', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-reporting-stored-'));
    try {
      const dbPath = usageStorePath(root);
      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-machine', label: 'Peer Machine' },
            rows: [
              makeSourcedRow({ project: 'peer-project', sessionId: 'peer-parent', sourcePath: '/work/peer' }),
              makeSourcedRow({
                parentSessionId: 'peer-parent',
                project: 'peer-project',
                sessionId: 'peer-child',
                sourcePath: '/work/peer',
              }),
            ],
          }),
          dbPath,
          localMachineId: testMachine.id,
        }),
      );

      const payload = await Effect.runPromise(
        createStoredReportPayload({
          config: {},
          dbPath,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          harness: null,
          includeCursor: false,
          machine: testMachine,
          options: defaultOptions,
        }),
      );

      expect(payload.rows).toHaveLength(2);
      expect(payload.rows[0]?.project).toBe('peer-project — Peer Machine');
      expect(payload.rows[0]?.rawProject).toBe('peer-project');
      expect(payload.rows[0]?.source?.machineLabel).toBe('Peer Machine');
      expect(payload.rows.find((row) => row.name === 'peer-child')?.source?.rootSourceSessionId).toBe('peer-parent');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('fingerprints the exact stored generation and semantic config', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-report-source-fingerprint-'));
    try {
      const dbPath = usageStorePath(root);
      await Effect.runPromise(initializeUsageStore({ dbPath }));
      const initialConfig = {
        projectAliases: [{ match: ['/work/raw'], name: 'Raw Project' }],
        projectGroups: [],
      };
      const reorderedConfig = {
        projectAliases: [{ name: 'Raw Project', match: ['/work/raw'] }],
        projectGroups: [],
      };
      const renamedConfig = {
        projectAliases: [{ match: ['/work/raw'], name: 'Renamed Project' }],
        projectGroups: [],
      };
      const readFingerprint = (config: typeof initialConfig) =>
        Effect.runPromise(readStoredReportSourceFingerprint({ config, dbPath }));
      const initial = await readFingerprint(initialConfig);

      expect(await readFingerprint(reorderedConfig)).toEqual(initial);

      const configChanged = await readFingerprint(renamedConfig);
      expect(configChanged.configFingerprint).not.toBe(initial.configFingerprint);
      expect(configChanged.machineFleetGeneration).toBe(initial.machineFleetGeneration);
      expect(configChanged.usageStoreGeneration).toBe(initial.usageStoreGeneration);

      const peerBundle = createUsageMergeBundle({
        machine: { id: 'peer-machine', label: 'Peer Machine' },
        rows: [makeSourcedRow({ project: 'peer-project', sessionId: 'peer-session', sourcePath: '/work/peer' })],
      });
      await Effect.runPromise(importPeerMergeBundle({ bundle: peerBundle, dbPath, localMachineId: testMachine.id }));
      const storeChanged = await readFingerprint(renamedConfig);
      expect(storeChanged.configFingerprint).toBe(configChanged.configFingerprint);
      expect(storeChanged.machineFleetGeneration).toBe(configChanged.machineFleetGeneration + 1);
      expect(storeChanged.usageStoreGeneration).toBe(configChanged.usageStoreGeneration + 1);

      await Effect.runPromise(importPeerMergeBundle({ bundle: peerBundle, dbPath, localMachineId: testMachine.id }));
      const fleetOnlyChanged = await readFingerprint(renamedConfig);
      expect(fleetOnlyChanged.machineFleetGeneration).toBe(storeChanged.machineFleetGeneration + 1);
      expect(fleetOnlyChanged.usageStoreGeneration).toBe(storeChanged.usageStoreGeneration);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('projects configured project groups as native report projects', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-reporting-project-groups-'));
    try {
      const dbPath = usageStorePath(root);
      const config = {
        projectGroups: [
          {
            id: 'exalibur',
            name: 'exalibur',
            sources: [
              { machineId: 'peer-a', sourcePath: '/work/exalibur' },
              { machineId: 'peer-a', sourcePath: '/work/exalibur2' },
              { machineId: 'peer-b', sourcePath: '/Users/example/exalibur' },
              { machineId: 'peer-b', sourcePath: '/missing/exalibur3' },
            ],
          },
        ],
      };
      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-a', label: 'Machine A' },
            rows: [
              makeSourcedRow({ project: 'exalibur', sessionId: 'a-exalibur', sourcePath: '/work/exalibur' }),
              makeSourcedRow({ project: 'exalibur2', sessionId: 'a-exalibur2', sourcePath: '/work/exalibur2' }),
            ],
          }),
          dbPath,
          localMachineId: testMachine.id,
        }),
      );
      await Effect.runPromise(
        importPeerMergeBundle({
          bundle: createUsageMergeBundle({
            machine: { id: 'peer-b', label: 'Machine B' },
            rows: [
              makeSourcedRow({
                project: 'exalibur',
                sessionId: 'b-exalibur',
                sourcePath: '/Users/example/exalibur',
              }),
            ],
          }),
          dbPath,
          localMachineId: testMachine.id,
        }),
      );

      const payload = await Effect.runPromise(
        createStoredReportPayload({
          config,
          dbPath,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          harness: null,
          includeCursor: false,
          includeFacets: true,
          machine: testMachine,
          options: defaultOptions,
        }),
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
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe('portable reporting', () => {
  test('surfaces provider status from remote snapshots', () => {
    const remoteStatus = createProviderStatusDataset(
      [
        {
          generatedAt: '2026-01-01T00:00:00.000Z',
          key: 'codex',
          label: 'Codex',
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
      datasets: { providerStatus: remoteStatus },
      machine: { id: 'peer-machine', label: 'Peer Machine' },
      rows: [makeSourcedRow({ project: 'peer-project', sessionId: 'peer-parent', sourcePath: '/work/peer' })],
    });

    const result = assembleMergedUsageReport({
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      harness: null,
      includeCursor: false,
      includeFacets: true,
      options: defaultOptions,
      snapshots: [snapshot],
    });

    expect(result.payload.datasets?.providerStatus?.providers[0]).toMatchObject({
      key: 'codex',
      machineId: 'peer-machine',
    });
  });

  test('keeps portable Claude worktree-looking paths opaque', () => {
    const parentPath = '/Users/example/projects/github/Exalibur2';
    const snapshot = createUsageSnapshot({
      machine: testMachine,
      rows: [
        makeSourcedRow({
          project: 'agent-a15e8356ff54ade2a',
          sessionId: 'agent-session-1',
          sourcePath: `${parentPath}/.claude/worktrees/agent-a15e8356ff54ade2a`,
        }),
        makeSourcedRow({
          project: 'agent-a2017811a25de4a7c',
          sessionId: 'agent-session-2',
          sourcePath: `${parentPath}/.claude/worktrees/agent-a2017811a25de4a7c`,
        }),
      ],
    });

    const merged = assembleMergedUsageReport({
      generatedAt: new Date('2026-01-03T00:00:00.000Z'),
      harness: null,
      includeCursor: false,
      options: defaultOptions,
      snapshots: [snapshot],
    });

    expect(merged.rows).toHaveLength(2);
    expect(merged.rows.map((row) => row.project).sort()).toEqual([
      'agent-a15e8356ff54ade2a — Test Machine',
      'agent-a2017811a25de4a7c — Test Machine',
    ]);
    expect(merged.payload.projectGroups?.map((group) => group.sources[0]?.sourcePath).sort()).toEqual([
      `${parentPath}/.claude/worktrees/agent-a15e8356ff54ade2a`,
      `${parentPath}/.claude/worktrees/agent-a2017811a25de4a7c`,
    ]);
  });

  test('drops duplicate snapshots and applies injected aliases after merge', () => {
    const older = createUsageSnapshot({
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      machine: testMachine,
      rows: [
        makeSourcedRow({ project: 'raw', sessionId: 'session-1', sourcePath: '/work/raw' }),
        makeSourcedRow({
          parentSessionId: 'session-1',
          project: 'raw-child',
          sessionId: 'session-2',
          sourcePath: '/work/raw',
        }),
      ],
    });
    const newer = createUsageSnapshot({
      generatedAt: new Date('2026-01-02T00:00:00.000Z'),
      machine: testMachine,
      rows: [
        makeSourcedRow({
          project: 'raw-newer',
          sessionId: 'session-1',
          sourcePath: '/work/raw',
          tokens: { cr: 0, cw: 0, in: 20, out: 10 },
        }),
        makeSourcedRow({
          parentSessionId: 'session-1',
          project: 'raw-child-newer',
          sessionId: 'session-2',
          sourcePath: '/work/raw',
          tokens: { cr: 0, cw: 0, in: 8, out: 4 },
        }),
      ],
    });

    const merged = assembleMergedUsageReport({
      generatedAt: new Date('2026-01-03T00:00:00.000Z'),
      harness: null,
      includeCursor: false,
      options: defaultOptions,
      projectAliases: [{ match: ['/work/raw'], name: 'Aliased Project' }],
      snapshots: [older, newer],
    });

    expect(merged.duplicatesDropped).toBe(2);
    expect(merged.warnings).toHaveLength(3);
    expect(merged.rows).toHaveLength(2);
    expect(merged.rows[0]?.project).toBe('Aliased Project');
    expect(merged.rows[0]?.rawProject).toBe('raw-newer');
    expect(merged.payload.warnings?.some((warning) => warning.reason === 'legacy-alias')).toBe(true);
    expect(merged.rows.find((row) => row.name === 'session-2')?.source.rootSourceSessionId).toBe('session-1');
  });

  test('assembles injected durable project groups without local services', () => {
    const snapshot = createUsageSnapshot({
      machine: testMachine,
      rows: [makeSourcedRow({ project: 'raw', sessionId: 'session-1', sourcePath: '/work/raw' })],
    });

    const merged = assembleMergedUsageReport({
      harness: null,
      includeCursor: false,
      options: defaultOptions,
      projectGroupConfigs: [{ id: 'group-a', name: 'Grouped', sources: [{ sourcePath: '/work/raw' }] }],
      snapshots: [snapshot],
    });

    expect(merged.rows[0]?.project).toBe('Grouped');
    expect(merged.payload.projectGroupConfigs?.[0]?.id).toBe('group-a');
  });

  test('does not inspect project metadata declared by portable snapshots', () => {
    const projectPath = '/portable/repository';
    const snapshot = createUsageSnapshot({
      machine: testMachine,
      rows: [
        makeSourcedRow({ project: 'repo', sessionId: 'session-1', sourcePath: projectPath }),
        makeSourcedRow({
          project: 'repo',
          sessionId: 'session-2',
          sourcePath: projectPath,
          tokens: { cr: 0, cw: 0, in: 4, out: 1 },
        }),
      ],
    });
    let gitReadCalls = 0;

    const result = collectProjectSourcesFromSnapshots({
      harness: null,
      includeCursor: false,
      includeGitRemote: true,
      readGitFile: () => {
        gitReadCalls++;
        return '[remote "origin"]\n  url = git@github.com:owner/repo.git\n';
      },
      snapshots: [snapshot],
    });

    expect(result.sources).toEqual([
      expect.objectContaining({
        gitRemote: '',
        harness: 'Claude Code',
        harnessKey: 'claude',
        machine: 'Test Machine',
        machineId: 'machine-1',
        project: 'repo',
        sessions: 2,
        sourcePath: projectPath,
        tokens: 20,
      }),
    ]);
    expect(gitReadCalls).toBe(0);
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
