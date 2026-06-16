import { calculateAnalytics } from '@ai-usage/core/analytics';
import type { SerializedRow, UsageReportPayload } from '@ai-usage/core/report-data';

export interface CursorCommitAttributionFacet {
  commitHash: string;
  branchName: string;
  scoredAt: string | null;
  commitMessage: string | null;
  commitDate: string | null;
  linesAdded: number;
  linesDeleted: number;
  tabLinesAdded: number;
  tabLinesDeleted: number;
  composerLinesAdded: number;
  composerLinesDeleted: number;
  humanLinesAdded: number;
  humanLinesDeleted: number;
  blankLinesAdded: number;
  blankLinesDeleted: number;
  v1AiPercentage: number | null;
  v2AiPercentage: number | null;
}

declare global {
  interface Window {
    __AI_USAGE_REPORT__?: UsageReportPayload;
  }
}

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
    tokIn: 62000,
    tokOut: 9400,
    tokCr: 130000,
    tokCw: 2100,
    tokenTotal: 203500,
    freshTokens: 73500,
    costActual: 3.2,
    costApprox: 3.2,
    costKnown: true,
    calls: 18,
    durationMs: 6120000,
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
    tokIn: 28000,
    tokOut: 4600,
    tokCr: 44000,
    tokCw: 0,
    tokenTotal: 76600,
    freshTokens: 32600,
    costActual: 0,
    costApprox: 0,
    costKnown: true,
    calls: 9,
    durationMs: 1740000,
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
    tokIn: 41000,
    tokOut: 7800,
    tokCr: 72000,
    tokCw: 0,
    tokenTotal: 120800,
    freshTokens: 48800,
    costActual: 0.84,
    costApprox: 0.84,
    costKnown: true,
    calls: 12,
    durationMs: 4380000,
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
    tokIn: 19000,
    tokOut: 2600,
    tokCr: 31000,
    tokCw: 0,
    tokenTotal: 52600,
    freshTokens: 21600,
    costActual: null,
    costApprox: 0,
    costKnown: false,
    calls: 6,
    durationMs: 2700000,
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

const demoPayload: UsageReportPayload = {
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

const isCursorCommitAttribution = (value: unknown): value is CursorCommitAttributionFacet => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commitHash === 'string' &&
    typeof record.branchName === 'string' &&
    typeof record.linesAdded === 'number' &&
    typeof record.linesDeleted === 'number'
  );
};

export const readReportPayload = () =>
  (typeof window === 'undefined' ? undefined : window.__AI_USAGE_REPORT__) ?? demoPayload;

export const isDemoReportPayload = () => typeof window === 'undefined' || !window.__AI_USAGE_REPORT__;

export const fetchReportPayload = async (options?: { force?: boolean }) => {
  const search = options?.force ? '?force=1' : '';
  const response = await fetch(`/__ai_usage_report_payload${search}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to refresh report payload (${response.status})`);
  const payload = (await response.json()) as UsageReportPayload;
  window.__AI_USAGE_REPORT__ = payload;
  return payload;
};

export const cursorCommitAttributionFacet = (payload: UsageReportPayload): CursorCommitAttributionFacet[] => {
  const cursor = payload.facets?.cursor;
  if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return [];
  const commitAttribution = (cursor as Record<string, unknown>).commitAttribution;
  if (!Array.isArray(commitAttribution)) return [];
  return commitAttribution.filter(isCursorCommitAttribution);
};
