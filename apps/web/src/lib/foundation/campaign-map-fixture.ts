import type { SerializedRow } from '@ai-usage/report-core/report-data';

export const campaignMapFixtureGeneratedAt = '2026-06-11T12:00:00.000Z';
export const campaignMapFixtureRootKey = 'campaign-demo-machine:codex:forecast-root';

interface FixtureSession {
  end: string | null;
  id: string;
  parent?: string;
  start: string;
  title: string;
  tokens: number;
}

const forecastSession = ({ end, id, parent, start, title, tokens }: FixtureSession): SerializedRow => {
  const date = `2026-06-11T${start}:00.000Z`;
  const endDate = end === null ? null : `2026-06-11T${end}:00.000Z`;
  const tokIn = tokens * 0.2;
  const tokOut = tokens * 0.05;
  const tokCr = tokens * 0.75;
  return {
    activeDate: endDate ?? date,
    calls: 12,
    costActual: tokens / 100_000,
    costApprox: tokens / 100_000,
    costKnown: true,
    date,
    durationMs: endDate === null ? null : Date.parse(endDate) - Date.parse(date),
    endDate,
    freshTokens: tokIn + tokOut,
    harness: 'Codex',
    lineDelta: null,
    linesAdded: null,
    linesDeleted: null,
    model: 'gpt-5.3-codex',
    name: title,
    origin: parent ? 'subagent' : 'human',
    project: 'world-state',
    provider: 'Codex API',
    sessionLabel: title,
    source: {
      harnessKey: 'codex',
      machineId: 'campaign-demo-machine',
      machineLabel: 'Demo workstation',
      ...(parent ? { parentSourceSessionId: parent } : {}),
      rootSourceSessionId: 'forecast-root',
      sourceSessionId: id,
    },
    subagent: parent !== undefined,
    titleSource: 'ai',
    tokCr,
    tokCw: 0,
    tokenTotal: tokens,
    tokIn,
    tokOut,
    tools: 24,
    turns: 14,
  };
};

const withoutDeclaredOrigin = ({ origin: _origin, ...row }: SerializedRow): SerializedRow => row;

/**
 * An isolated, content-free report example for Campaigns. The main campaign spans
 * 80 minutes, contains 210 minutes of observed session intervals, and peaks at
 * four overlapping sessions. It does not alter the shared report fixture.
 */
export const campaignMapFixtureRows: SerializedRow[] = [
  forecastSession({
    end: '09:20',
    id: 'forecast-root',
    start: '08:00',
    title: 'Build forecast model',
    tokens: 400_000,
  }),
  forecastSession({
    end: '08:35',
    id: 'forecast-model',
    parent: 'forecast-root',
    start: '08:05',
    title: 'Define the data model',
    tokens: 240_000,
  }),
  forecastSession({
    end: '09:00',
    id: 'forecast-ingestion',
    parent: 'forecast-root',
    start: '08:10',
    title: 'Implement market ingestion',
    tokens: 320_000,
  }),
  forecastSession({
    end: '08:45',
    id: 'forecast-tests',
    parent: 'forecast-ingestion',
    start: '08:20',
    title: 'Verify ingestion edge cases',
    tokens: 160_000,
  }),
  {
    ...forecastSession({
      end: '09:15',
      id: 'forecast-review',
      parent: 'forecast-root',
      start: '08:50',
      title: 'Review forecast changes',
      tokens: 180_000,
    }),
    model: 'gpt-5.2',
  },
  {
    ...forecastSession({
      end: '07:40',
      id: 'release-notes',
      start: '07:10',
      title: 'Review release notes',
      tokens: 80_000,
    }),
    costActual: 0,
    harness: 'Claude',
    model: 'claude-sonnet-4.5',
    project: 'ai-usage',
    provider: 'Claude sub',
    source: {
      harnessKey: 'claude',
      machineId: 'campaign-demo-machine',
      machineLabel: 'Demo workstation',
      rootSourceSessionId: 'release-notes',
      sourceSessionId: 'release-notes',
    },
  },
  {
    ...withoutDeclaredOrigin(
      forecastSession({
        end: null,
        id: 'cursor-layout',
        start: '07:00',
        title: 'Explore dashboard layout',
        tokens: 60_000,
      }),
    ),
    costActual: null,
    costApprox: 0,
    costKnown: false,
    harness: 'Cursor',
    model: 'cursor-agent',
    originProvenance: 'origin-unsupported',
    partial: true,
    project: 'aroven',
    provider: 'Cursor local',
    source: {
      harnessKey: 'cursor',
      machineId: 'campaign-demo-machine',
      machineLabel: 'Demo workstation',
      rootSourceSessionId: 'cursor-layout',
      sourceSessionId: 'cursor-layout',
    },
  },
  {
    ...forecastSession({
      end: '06:55',
      id: 'orphan-review',
      parent: 'unavailable-parent',
      start: '06:45',
      title: 'Check migration compatibility',
      tokens: 40_000,
    }),
    costActual: 0,
    harness: 'Claude',
    model: 'claude-sonnet-4.5',
    project: 'ai-usage',
    provider: 'Claude sub',
    source: {
      harnessKey: 'claude',
      machineId: 'campaign-demo-machine',
      machineLabel: 'Demo workstation',
      parentSourceSessionId: 'unavailable-parent',
      // This is the normalizer's fallback when the declared parent is absent.
      rootSourceSessionId: 'orphan-review',
      sourceSessionId: 'orphan-review',
    },
  },
];
