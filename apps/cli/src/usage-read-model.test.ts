import { expect, test } from 'bun:test';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createUsageReportPayload, prepareUsageReport, serializeUsageRow } from '@ai-usage/report-core/report-data';
import type { SourcedRow } from '@ai-usage/report-core/types';
import type { Args } from './cli';
import { createServedUsageReport, createServedUsageSnapshot, reportSourceIdsFor } from './usage-read-model';

const args = (overrides: Partial<Args> = {}): Args => ({
  color: false,
  cursor: true,
  format: 'payload',
  harness: null,
  limit: null,
  minTokens: 1,
  project: null,
  since: null,
  sort: 'date',
  stored: false,
  wide: false,
  ...overrides,
});

const row = (harness: 'Codex' | 'Cursor', harnessKey: 'codex' | 'cursor', name: string): SourcedRow => ({
  calls: 1,
  costActual: 0.1,
  costApprox: 0.1,
  costKnown: true,
  date: new Date('2026-01-01T00:00:00.000Z'),
  durationMs: 60_000,
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness,
  linesAdded: null,
  linesDeleted: null,
  model: 'fixture-model',
  name,
  project: 'fixture',
  provider: 'fixture-provider',
  source: { harnessKey, sourceSessionId: name },
  tokCr: 0,
  tokCw: 0,
  tokIn: 10,
  tokOut: 5,
  tools: 0,
  turns: 1,
});

const generatedAt = new Date('2026-01-02T00:00:00.000Z');

test('assembles an exact served revision while filtering Cursor rows and datasets together', () => {
  const rows = [row('Codex', 'codex', 'codex-row'), row('Cursor', 'cursor', 'cursor-row')];
  const base = createUsageReportPayload(prepareUsageReport(rows, args()), args(), generatedAt, undefined, [
    { harness: 'codex', message: 'durable warning', operation: 'fixture' },
  ]);
  const support: FocusedReportSupport = {
    ...base,
    datasets: {
      cursorCommitAttribution: [
        {
          blankLinesAdded: 0,
          blankLinesDeleted: 0,
          branchName: 'main',
          commitDate: '2026-01-01T00:00:00.000Z',
          commitHash: 'a'.repeat(40),
          commitMessage: 'fixture',
          composerLinesAdded: 0,
          composerLinesDeleted: 0,
          humanLinesAdded: 0,
          humanLinesDeleted: 0,
          linesAdded: 0,
          linesDeleted: 0,
          scoredAt: null,
          tabLinesAdded: 0,
          tabLinesDeleted: 0,
          v1AiPercentage: null,
          v2AiPercentage: null,
        },
      ],
    },
    warnings: [
      { harness: 'codex', message: 'durable warning', operation: 'fixture' },
      { harness: 'cursor', message: 'hidden Cursor warning', operation: 'cursor.sessions' },
    ],
  };
  const selectedArgs = args({ cursor: false });
  const result = createServedUsageReport({
    args: selectedArgs,
    rows: rows.map(serializeUsageRow),
    selection: { harness: null, includeCursor: false },
    support,
    warnings: [{ harness: 'codex', message: 'fresh warning', operation: 'codex.sessions' }],
  });

  expect(result.rows.map(({ name }) => name)).toEqual(['codex-row']);
  expect(result.payload.generatedAt).toBe(generatedAt.toISOString());
  expect(result.payload.datasets?.cursorCommitAttribution).toBeUndefined();
  expect(result.payload.facets?.cursor).toBeUndefined();
  expect(result.payload.warnings?.map(({ message }) => message)).toEqual(['durable warning', 'fresh warning']);
});

test('preserves report grouping metadata but exports raw ungrouped snapshot projects', () => {
  const sourceRow = row('Codex', 'codex', 'grouped-row');
  const serialized = {
    ...serializeUsageRow(sourceRow),
    project: 'Configured Group',
    projectGroupId: 'group-a',
    projectSourceId: 'source-a',
    rawProject: 'raw-project',
  };
  const base = createUsageReportPayload(prepareUsageReport([sourceRow], args()), args(), generatedAt);
  const support: FocusedReportSupport = {
    ...base,
    projectGroupConfigs: [{ id: 'group-a', name: 'Configured Group', sources: [{ project: 'raw-project' }] }],
    projectGroups: [
      {
        cache: 0,
        cost: 0.1,
        fresh: 15,
        grouped: true,
        id: 'group-a',
        linesAdded: 0,
        linesDeleted: 0,
        name: 'Configured Group',
        priced: 1,
        sessions: 1,
        sources: [
          {
            gitRemote: '',
            id: 'source-a',
            machineId: 'machine-a',
            machineLabel: 'Machine A',
            project: 'raw-project',
            sessions: 1,
            sourcePath: '',
            tokens: 15,
          },
        ],
        tokens: 15,
        tools: 0,
        turns: 1,
      },
    ],
  };

  const report = createServedUsageReport({
    args: args(),
    rows: [serialized],
    selection: { harness: null, includeCursor: true },
    support,
  });
  const snapshot = createServedUsageSnapshot({
    machine: { id: 'machine-a', label: 'Machine A' },
    rows: [serialized],
    selection: { harness: null, includeCursor: true },
    support,
  });

  expect(report.rows[0]).toMatchObject({
    project: 'Configured Group',
    projectGroupId: 'group-a',
    projectSourceId: 'source-a',
    rawProject: 'raw-project',
  });
  expect(report.payload.projectGroups?.[0]).toMatchObject({ sessions: 1, sources: [{ sessions: 1 }] });
  expect(snapshot.rows[0]?.project).toBe('raw-project');
  expect(snapshot.rows[0]).not.toHaveProperty('rawProject');
  expect(snapshot.rows[0]).not.toHaveProperty('projectGroupId');
  expect(snapshot.rows[0]).not.toHaveProperty('projectSourceId');
});

test('uses the same canonical source ordering as the engine batch', () => {
  expect(reportSourceIdsFor({ harness: null, includeCursor: false })).toEqual([
    'claude.sessions',
    'codex.sessions',
    'opencode.sessions',
    'rtk.savings',
  ]);
  expect(reportSourceIdsFor({ harness: 'cursor', includeCursor: false })).toEqual([]);
  expect(reportSourceIdsFor({ harness: 'cursor', includeCursor: true })).toEqual([
    'cursor.sessions',
    'rtk.savings',
    'cursor.commit-attribution',
  ]);
});
