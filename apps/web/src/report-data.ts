import { calculateAnalytics } from '@ai-usage/report-core/analytics';
import { type CursorCommitAttributionRow, isCursorCommitAttributionRow } from '@ai-usage/report-core/datasets';
import type { SerializedRow, UsageReportPayload } from '@ai-usage/report-core/report-data';

export type CursorCommitAttributionFacet = CursorCommitAttributionRow;

const demoRows: SerializedRow[] = [
  {
    date: '2026-06-11T08:00:00.000Z',
    endDate: '2026-06-11T09:42:00.000Z',
    activeDate: '2026-06-11T09:42:00.000Z',
    harness: 'Codex',
    provider: 'Codex API',
    name: 'Build report UI',
    sessionLabel: 'Build report UI',
    model: 'gpt-5.3-codex',
    project: 'ai-usage',
    tokIn: 62_000,
    tokOut: 9400,
    tokCr: 130_000,
    tokCw: 2100,
    tokenTotal: 203_500,
    freshTokens: 73_500,
    costActual: 3.2,
    costApprox: 3.2,
    costKnown: true,
    calls: 18,
    durationMs: 6_120_000,
    turns: 22,
    tools: 64,
    linesAdded: 860,
    linesDeleted: 120,
    lineDelta: 980,
  },
  {
    date: '2026-06-10T18:15:00.000Z',
    endDate: '2026-06-10T18:44:00.000Z',
    activeDate: '2026-06-10T18:44:00.000Z',
    harness: 'Claude',
    provider: 'Claude sub',
    name: 'Review analytics model',
    sessionLabel: 'Review analytics model',
    model: 'claude-sonnet-4.5',
    project: 'ai-usage',
    tokIn: 28_000,
    tokOut: 4600,
    tokCr: 44_000,
    tokCw: 0,
    tokenTotal: 76_600,
    freshTokens: 32_600,
    costActual: 0,
    costApprox: 0,
    costKnown: true,
    calls: 9,
    durationMs: 1_740_000,
    turns: 11,
    tools: 18,
    linesAdded: null,
    linesDeleted: null,
    lineDelta: null,
    subagent: false,
  },
  {
    date: '2026-05-25T13:05:00.000Z',
    endDate: '2026-05-25T14:18:00.000Z',
    activeDate: '2026-05-25T14:18:00.000Z',
    harness: 'OpenCode',
    provider: 'OpenCode',
    name: 'Tune collector fixtures',
    sessionLabel: 'Tune collector fixtures',
    model: 'qwen3-coder',
    project: 'ai-usage',
    tokIn: 41_000,
    tokOut: 7800,
    tokCr: 72_000,
    tokCw: 0,
    tokenTotal: 120_800,
    freshTokens: 48_800,
    costActual: 0.84,
    costApprox: 0.84,
    costKnown: true,
    calls: 12,
    durationMs: 4_380_000,
    turns: 16,
    tools: 27,
    linesAdded: 220,
    linesDeleted: 45,
    lineDelta: 265,
  },
  {
    date: '2026-04-12T09:20:00.000Z',
    endDate: '2026-04-12T10:05:00.000Z',
    activeDate: '2026-04-12T10:05:00.000Z',
    harness: 'Cursor',
    provider: 'Cursor local',
    name: 'Explore report sketch',
    sessionLabel: 'Explore report sketch',
    model: 'cursor-agent',
    project: 'ai-usage',
    tokIn: 19_000,
    tokOut: 2600,
    tokCr: 31_000,
    tokCw: 0,
    tokenTotal: 52_600,
    freshTokens: 21_600,
    costActual: null,
    costApprox: 0,
    costKnown: false,
    calls: 6,
    durationMs: 2_700_000,
    turns: 8,
    tools: 9,
    linesAdded: null,
    linesDeleted: null,
    lineDelta: null,
    partial: true,
  },
];

const demoRowsForAnalytics = () =>
  demoRows.map((row) => ({
    ...row,
    date: row.date ? new Date(row.date) : null,
    endDate: row.endDate ? new Date(row.endDate) : null,
  }));

export const demoReportPayload: UsageReportPayload = {
  generatedAt: '2026-06-11T12:00:00.000Z',
  filters: {
    since: null,
    project: null,
    limit: 12,
    minTokens: 1,
    sort: 'cost',
  },
  rows: demoRows,
  tableRows: demoRows,
  omittedRows: 0,
  analytics: calculateAnalytics(demoRowsForAnalytics(), new Date('2026-06-11T12:00:00.000Z').getTime()),
  datasets: {
    cursorCommitAttribution: [
      {
        commitHash: 'da59e06cc4c9627584edec0f8dc06f7e4cdd199d',
        branchName: 'main',
        scoredAt: '2026-03-13T08:28:49.536Z',
        commitMessage: 'tanstack init',
        commitDate: 'Fri Mar 6 09:32:20 2026 +0100',
        linesAdded: 671,
        linesDeleted: 1,
        tabLinesAdded: 18,
        tabLinesDeleted: 0,
        composerLinesAdded: 0,
        composerLinesDeleted: 0,
        humanLinesAdded: 101,
        humanLinesDeleted: 0,
        blankLinesAdded: 249,
        blankLinesDeleted: 0,
        v1AiPercentage: 2.68,
        v2AiPercentage: 76.12,
      },
    ],
  },
  facets: {
    cursor: {
      commitAttribution: [
        {
          commitHash: 'da59e06cc4c9627584edec0f8dc06f7e4cdd199d',
          branchName: 'main',
          scoredAt: '2026-03-13T08:28:49.536Z',
          commitMessage: 'tanstack init',
          commitDate: 'Fri Mar 6 09:32:20 2026 +0100',
          linesAdded: 671,
          linesDeleted: 1,
          tabLinesAdded: 18,
          tabLinesDeleted: 0,
          composerLinesAdded: 0,
          composerLinesDeleted: 0,
          humanLinesAdded: 101,
          humanLinesDeleted: 0,
          blankLinesAdded: 249,
          blankLinesDeleted: 0,
          v1AiPercentage: 2.68,
          v2AiPercentage: 76.12,
        },
      ],
    },
  },
};

export const cursorCommitAttributionFacet = (payload: UsageReportPayload): CursorCommitAttributionFacet[] => {
  if (Array.isArray(payload.datasets?.cursorCommitAttribution)) {
    return payload.datasets.cursorCommitAttribution.filter(isCursorCommitAttributionRow);
  }
  const cursor = payload.facets?.cursor;
  if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
    return [];
  }
  const commitAttribution = (cursor as Record<string, unknown>).commitAttribution;
  if (!Array.isArray(commitAttribution)) {
    return [];
  }
  return commitAttribution.filter(isCursorCommitAttributionRow);
};
