import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { SerializedRow } from '@ai-usage/core/report-data';
import { Tabs } from '@ark-ui/solid/tabs';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { css, cx } from '../styled-system/css';
import {
  type DateRangeMode,
  dateBoundsForRange,
  rowMatchesDateBounds,
  rowsDateSpan,
  startOfDay,
  toDateInputValue,
} from './date-range';
import { readReportPayload } from './report-data';

const payload = readReportPayload();

const fmtNum = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n);
const fmtMoney = (n: number | null | undefined) => (n == null ? '-' : `$${n.toFixed(2)}`);
const fmtPct = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`;
const fmtMaybeNum = (n: number | null | undefined) => (n == null ? '-' : fmtNum(n));
const fmtDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '-';
const fmtDateOnly = (value: string | Date | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      }).format(value instanceof Date ? value : new Date(value))
    : '-';

const fmtDuration = (ms: number | null) => {
  if (!ms || ms <= 0) return '-';
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
};

const shiftCalendarDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const page = css({
  minHeight: '100vh',
  boxSizing: 'border-box',
  bg: 'canvas',
  color: 'ink',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '& *': {
    boxSizing: 'border-box',
  },
  '& *::before': {
    boxSizing: 'border-box',
  },
  '& *::after': {
    boxSizing: 'border-box',
  },
});

const shell = css({
  maxWidth: '1440px',
  boxSizing: 'border-box',
  mx: 'auto',
  px: { base: '16px', md: '28px' },
  py: { base: '18px', md: '28px' },
});

const header = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1fr) auto' },
  gap: '16px',
  alignItems: 'end',
  pb: '18px',
  borderBottom: '1px solid token(colors.line)',
});

const titleBlock = css({
  display: 'grid',
  gap: '6px',
});

const eyebrow = css({
  color: 'muted',
  fontSize: '13px',
  fontWeight: 650,
  textTransform: 'uppercase',
  letterSpacing: '0',
});

const title = css({
  fontSize: { base: '28px', md: '36px' },
  lineHeight: '1.05',
  fontWeight: 760,
});

const meta = css({
  color: 'muted',
  fontSize: '14px',
  overflowWrap: 'anywhere',
});

const filterSummary = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 10px',
  alignItems: 'center',
  color: 'muted',
  fontSize: '13px',
  pt: '12px',
});

const summaryPill = css({
  display: 'inline-flex',
  alignItems: 'center',
  minH: '24px',
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  color: 'ink',
  fontWeight: 700,
});

const controls = css({
  display: 'grid',
  gridTemplateColumns: {
    base: '1fr',
    md: 'repeat(2, minmax(180px, 1fr))',
    xl: 'minmax(220px, 360px) minmax(148px, 180px) minmax(148px, 180px) repeat(2, 140px) auto',
  },
  gap: '10px',
  alignItems: 'center',
});

const searchInput = css({
  width: '100%',
  h: '40px',
  px: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  color: 'ink',
  fontSize: '14px',
  outline: 'none',
  _focusVisible: {
    borderColor: 'teal',
    boxShadow: '0 0 0 3px rgba(13, 105, 134, 0.16)',
  },
});

const selectInput = css({
  h: '40px',
  minW: '0',
  width: '100%',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  color: 'ink',
  fontSize: '14px',
});

const dateInput = css({
  width: '100%',
  h: '40px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  color: 'ink',
  fontSize: '14px',
});

const commandButton = css({
  h: '40px',
  px: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'ink',
  color: 'surface',
  fontSize: '14px',
  fontWeight: 720,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _hover: {
    bg: '#24322c',
  },
  _focusVisible: {
    outline: '2px solid token(colors.teal)',
    outlineOffset: '2px',
  },
});

const metricGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: '1fr 1fr', lg: 'repeat(6, minmax(0, 1fr))' },
  gap: '10px',
  my: '18px',
});

const metricTile = css({
  minH: '94px',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  display: 'grid',
  alignContent: 'space-between',
  gap: '10px',
});

const metricLabel = css({
  color: 'muted',
  fontSize: '12px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0',
});

const metricValue = css({
  fontSize: { base: '22px', md: '26px' },
  lineHeight: '1',
  fontWeight: 760,
});

const tabsRoot = css({
  display: 'grid',
  gap: '14px',
});

const tabsList = css({
  display: 'flex',
  gap: '4px',
  overflowX: 'auto',
  borderBottom: '1px solid token(colors.line)',
});

const tabTrigger = css({
  appearance: 'none',
  border: '0',
  borderBottom: '2px solid transparent',
  bg: 'transparent',
  color: 'muted',
  px: '12px',
  py: '10px',
  fontSize: '14px',
  fontWeight: 700,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  '&[data-selected]': {
    color: 'ink',
    borderColor: 'mint',
  },
  _focusVisible: {
    outline: '2px solid token(colors.teal)',
    outlineOffset: '2px',
  },
});

const section = css({
  display: 'grid',
  gap: '14px',
});

const tableWrap = css({
  overflowX: 'auto',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
});

const table = css({
  width: '100%',
  borderCollapse: 'collapse',
  minW: '1040px',
  tableLayout: 'fixed',
  fontSize: '13px',
  '& th': {
    color: 'muted',
    fontSize: '11px',
    fontWeight: 750,
    textTransform: 'uppercase',
    letterSpacing: '0',
    textAlign: 'left',
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
    bg: '#f8faf7',
  },
  '& td': {
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
    verticalAlign: 'top',
  },
  '& tr:last-child td': {
    borderBottom: '0',
  },
  '& tbody tr': {
    cursor: 'pointer',
  },
  '& tbody tr[data-selected="true"] td': {
    bg: '#eef6f2',
  },
});

const right = css({ textAlign: 'right' });
const muted = css({ color: 'muted' });
const strongCell = css({ fontWeight: 700, overflowWrap: 'anywhere' });
const mono = css({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' });

const sortButton = css({
  appearance: 'none',
  display: 'inline-flex',
  gap: '4px',
  alignItems: 'center',
  border: '0',
  p: '0',
  bg: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontWeight: 750,
  textTransform: 'inherit',
  cursor: 'pointer',
  _focusVisible: {
    outline: '2px solid token(colors.teal)',
    outlineOffset: '2px',
  },
});

const detailButton = css({
  appearance: 'none',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  color: 'ink',
  px: '9px',
  py: '6px',
  fontSize: '12px',
  fontWeight: 720,
  cursor: 'pointer',
  _hover: {
    borderColor: 'mint',
  },
  _focusVisible: {
    outline: '2px solid token(colors.teal)',
    outlineOffset: '2px',
  },
});

const pill = css({
  display: 'inline-flex',
  alignItems: 'center',
  minH: '22px',
  px: '8px',
  borderRadius: '999px',
  bg: '#eef6f2',
  color: 'mint',
  fontSize: '12px',
  fontWeight: 720,
});

const groupGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1fr) minmax(0, 1fr)' },
  gap: '12px',
});

const groupPanel = css({
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  overflow: 'hidden',
});

const groupHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'center',
  p: '12px',
  borderBottom: '1px solid token(colors.line)',
});

const groupTitle = css({
  fontSize: '15px',
  fontWeight: 760,
  overflowWrap: 'anywhere',
});

const groupRows = css({
  display: 'grid',
});

const groupRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 80px',
  gap: '12px',
  alignItems: 'center',
  px: '12px',
  py: '10px',
  borderBottom: '1px solid token(colors.line)',
  _last: {
    borderBottom: '0',
  },
});

const barTrack = css({
  h: '8px',
  borderRadius: '999px',
  bg: '#e3ebe6',
  overflow: 'hidden',
});

const barFill = css({
  h: '100%',
  borderRadius: '999px',
  bg: 'mint',
});

const empty = css({
  minH: '160px',
  display: 'grid',
  placeItems: 'center',
  color: 'muted',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
});

const detailPanel = css({
  display: 'grid',
  gap: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: '8px',
  bg: 'surface',
  p: '14px',
});

const detailHeader = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  gap: '10px',
  alignItems: 'start',
});

const detailGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
  gap: '10px',
});

const detailItem = css({
  display: 'grid',
  gap: '4px',
  minW: '0',
});

const detailLabel = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 750,
  textTransform: 'uppercase',
  letterSpacing: '0',
});

const detailValue = css({
  fontSize: '14px',
  fontWeight: 700,
  overflowWrap: 'anywhere',
});

const projectTable = css({
  minW: '780px',
});

type Metric = {
  label: string;
  value: string;
  tone: 'mint' | 'teal' | 'amber' | 'rose';
};

type TableSortKey = 'date' | 'fresh' | 'cache' | 'cost' | 'duration' | 'session';
type SortDirection = 'asc' | 'desc';
type ProjectGroup = {
  key: string;
  sessions: number;
  fresh: number;
  cache: number;
  cost: number;
  priced: number;
  turns: number;
  tools: number;
  linesAdded: number;
  linesDeleted: number;
};

const toneClass: Record<Metric['tone'], string> = {
  mint: css({ borderTop: '3px solid token(colors.mint)' }),
  teal: css({ borderTop: '3px solid token(colors.teal)' }),
  amber: css({ borderTop: '3px solid token(colors.amber)' }),
  rose: css({ borderTop: '3px solid token(colors.rose)' }),
};

const MetricTile = (props: Metric) => (
  <div class={cx(metricTile, toneClass[props.tone])}>
    <div class={metricLabel}>{props.label}</div>
    <div class={metricValue}>{props.value}</div>
  </div>
);

const rowKey = (row: SerializedRow) =>
  [row.activeDate ?? row.date ?? '', row.harness, row.provider, row.model, row.project, row.sessionLabel].join('|');

const matchesRow = (row: SerializedRow, query: string, harness: string) => {
  const haystack = `${row.sessionLabel} ${row.project} ${row.model} ${row.provider} ${row.harness}`.toLowerCase();
  return haystack.includes(query) && (harness === 'all' || row.harness === harness);
};

const csvEscape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

const reportRowsToCSV = (rows: SerializedRow[]) => {
  const head = [
    'date',
    'end_date',
    'active_date',
    'harness',
    'provider',
    'session',
    'model',
    'project',
    'input',
    'output',
    'cache_read',
    'cache_write',
    'fresh_tokens',
    'total_tokens',
    'cost_actual',
    'cost_approx_api',
    'cost_known',
    'calls',
    'duration_ms',
    'turns',
    'tools',
    'lines_added',
    'lines_deleted',
    'line_delta',
    'subagent',
    'partial',
  ];
  const body = rows.map((row) =>
    [
      row.date ?? '',
      row.endDate ?? '',
      row.activeDate ?? '',
      row.harness,
      row.provider,
      row.name,
      row.model,
      row.project,
      row.tokIn,
      row.tokOut,
      row.tokCr,
      row.tokCw,
      row.freshTokens,
      row.tokenTotal,
      row.costActual ?? '',
      row.costApprox.toFixed(4),
      row.costKnown,
      row.calls,
      row.durationMs ?? '',
      row.turns,
      row.tools,
      row.linesAdded ?? '',
      row.linesDeleted ?? '',
      row.lineDelta ?? '',
      row.subagent ?? false,
      row.partial ?? false,
    ]
      .map((item) => csvEscape(String(item)))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};

const downloadCSV = (rows: SerializedRow[]) => {
  const blob = new Blob([reportRowsToCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai-usage-report-${payload.generatedAt.slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

const compareRows = (key: TableSortKey, direction: SortDirection) => (a: SerializedRow, b: SerializedRow) => {
  const sign = direction === 'asc' ? 1 : -1;
  const read = (row: SerializedRow): number | string => {
    if (key === 'date') return new Date(row.activeDate ?? row.date ?? 0).getTime();
    if (key === 'fresh') return row.freshTokens;
    if (key === 'cache') return row.tokCr;
    if (key === 'cost') return row.costKnown ? row.costApprox : -1;
    if (key === 'duration') return row.durationMs ?? 0;
    return row.sessionLabel.toLowerCase();
  };
  const av = read(a);
  const bv = read(b);
  if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sign;
  return (av - bv) * sign;
};

const lineDeltaLabel = (row: SerializedRow) => {
  if (row.lineDelta == null || row.lineDelta === 0) return '-';
  return `+${fmtMaybeNum(row.linesAdded)}/-${fmtMaybeNum(row.linesDeleted)}`;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const rowsSummary = (rows: SerializedRow[]) => {
  const priced = rows.filter((row) => row.costKnown);
  const totalCost = priced.reduce((sum, row) => sum + row.costApprox, 0);
  return {
    sessionCount: rows.length,
    totalCost,
    meanCost: totalCost / (priced.length || 1),
    fresh: rows.reduce((sum, row) => sum + row.freshTokens, 0),
    turns: rows.reduce((sum, row) => sum + row.turns, 0),
    tools: rows.reduce((sum, row) => sum + row.tools, 0),
  };
};

const analyticsGroups = (rows: SerializedRow[], keyFn: (row: SerializedRow) => string): AnalyticsGroup[] => {
  const totalCost = rows.filter((row) => row.costKnown).reduce((sum, row) => sum + row.costApprox, 0);
  const groups = new Map<
    string,
    AnalyticsGroup & {
      costs: number[];
    }
  >();

  for (const row of rows) {
    const key = keyFn(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        harness: row.harness,
        provider: row.provider,
        sessions: 0,
        priced: 0,
        unpriced: 0,
        fresh: 0,
        inp: 0,
        cache: 0,
        cacheHitPct: 0,
        costSum: 0,
        costPerSession: null,
        medianCost: null,
        linesA: 0,
        linesD: 0,
        lineCount: 0,
        costPer100Lines: null,
        costPercent: 0,
        turns: 0,
        tools: 0,
        costs: [],
      };
      groups.set(key, group);
    }

    group.sessions++;
    group.fresh += row.freshTokens;
    group.inp += row.tokIn;
    group.cache += row.tokCr;
    group.linesA += row.linesAdded ?? 0;
    group.linesD += row.linesDeleted ?? 0;
    group.turns += row.turns;
    group.tools += row.tools;
    if (row.costKnown) {
      group.priced++;
      group.costSum += row.costApprox;
      group.costs.push(row.costApprox);
    } else {
      group.unpriced++;
    }
  }

  return [...groups.values()]
    .map((group) => {
      const lineCount = group.linesA + group.linesD;
      return {
        ...group,
        cacheHitPct: group.inp + group.cache > 0 ? (group.cache / (group.inp + group.cache)) * 100 : 0,
        costPerSession: group.priced ? group.costSum / group.priced : null,
        medianCost: group.priced ? median(group.costs) : null,
        lineCount,
        costPer100Lines: lineCount && group.priced ? (group.costSum / lineCount) * 100 : null,
        costPercent: totalCost > 0 ? (group.costSum / totalCost) * 100 : 0,
      };
    })
    .sort((a, b) => b.costSum - a.costSum);
};

const SortHeader = (props: {
  label: string;
  column: TableSortKey;
  current: TableSortKey;
  direction: SortDirection;
  onSort: (column: TableSortKey) => void;
  class?: string;
}) => (
  <button class={cx(sortButton, props.class)} type="button" onClick={() => props.onSort(props.column)}>
    <span>{props.label}</span>
    <Show when={props.current === props.column}>
      <span>{props.direction === 'asc' ? 'up' : 'down'}</span>
    </Show>
  </button>
);

const SessionTable = (props: {
  rows: SerializedRow[];
  selectedKey: string | null;
  sortKey: TableSortKey;
  sortDirection: SortDirection;
  onSort: (column: TableSortKey) => void;
  onSelect: (row: SerializedRow) => void;
}) => (
  <Show when={props.rows.length} fallback={<div class={empty}>No sessions</div>}>
    <div class={tableWrap}>
      <table class={table}>
        <thead>
          <tr>
            <th style={{ width: '112px' }}>
              <SortHeader
                label="Date"
                column="date"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
              />
            </th>
            <th style={{ width: '92px' }}>Harness</th>
            <th style={{ width: '150px' }}>Provider</th>
            <th style={{ width: '190px' }}>Model</th>
            <th style={{ width: '160px' }}>Project</th>
            <th style={{ width: '92px' }} class={right}>
              <SortHeader
                label="Fresh"
                column="fresh"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '92px' }} class={right}>
              <SortHeader
                label="Cache"
                column="cache"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '82px' }} class={right}>
              <SortHeader
                label="$API"
                column="cost"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '82px' }} class={right}>
              <SortHeader
                label="Span"
                column="duration"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th>
              <SortHeader
                label="Session"
                column="session"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
              />
            </th>
            <th style={{ width: '78px' }}>Inspect</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-selected={String(props.selectedKey === rowKey(row))} onClick={() => props.onSelect(row)}>
                <td class={muted}>{fmtDate(row.activeDate)}</td>
                <td>
                  <span class={pill}>{row.harness}</span>
                </td>
                <td>{row.provider}</td>
                <td class={cx(strongCell, mono)}>{row.model}</td>
                <td>{row.project || '-'}</td>
                <td class={right}>{fmtNum(row.freshTokens)}</td>
                <td class={right}>{fmtNum(row.tokCr)}</td>
                <td class={right}>{row.costKnown ? fmtMoney(row.costApprox) : '?'}</td>
                <td class={right}>{fmtDuration(row.durationMs)}</td>
                <td class={strongCell}>{row.sessionLabel}</td>
                <td>
                  <button class={detailButton} type="button" onClick={() => props.onSelect(row)}>
                    Details
                  </button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

const DetailItem = (props: { label: string; value: string }) => (
  <div class={detailItem}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const SessionDetail = (props: { row: SerializedRow | undefined }) => (
  <Show when={props.row}>
    {(row) => (
      <aside class={detailPanel}>
        <div class={detailHeader}>
          <div>
            <div class={groupTitle}>{row().sessionLabel}</div>
            <div class={muted}>
              {row().provider} · {row().model}
            </div>
          </div>
          <span class={pill}>{row().harness}</span>
        </div>
        <div class={detailGrid}>
          <DetailItem label="Started" value={fmtDate(row().date)} />
          <DetailItem label="Ended" value={fmtDate(row().endDate)} />
          <DetailItem label="Input" value={fmtNum(row().tokIn)} />
          <DetailItem label="Output" value={fmtNum(row().tokOut)} />
          <DetailItem label="Cache read" value={fmtNum(row().tokCr)} />
          <DetailItem label="Cache write" value={fmtNum(row().tokCw)} />
          <DetailItem label="Total tokens" value={fmtNum(row().tokenTotal)} />
          <DetailItem label="$API" value={row().costKnown ? fmtMoney(row().costApprox) : '?'} />
          <DetailItem label="Actual cost" value={fmtMoney(row().costActual)} />
          <DetailItem label="Calls" value={fmtNum(row().calls)} />
          <DetailItem label="Turns" value={fmtNum(row().turns)} />
          <DetailItem label="Tools" value={fmtNum(row().tools)} />
          <DetailItem label="Duration" value={fmtDuration(row().durationMs)} />
          <DetailItem label="Lines" value={lineDeltaLabel(row())} />
          <DetailItem label="Subagent" value={row().subagent ? 'Yes' : 'No'} />
          <DetailItem label="Partial" value={row().partial ? 'Yes' : 'No'} />
        </div>
      </aside>
    )}
  </Show>
);

const GroupPanel = (props: { title: string; groups: AnalyticsGroup[] }) => {
  const maxCost = createMemo(() => Math.max(1, ...props.groups.map((group) => group.costSum)));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <div class={muted}>{props.groups.length}</div>
      </div>
      <div class={groupRows}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <div>
                <div class={strongCell}>{group.key}</div>
                <div class={muted}>
                  {group.sessions} sess · {fmtNum(group.fresh)} fresh · {fmtPct(group.cacheHitPct)} cache
                </div>
                <div class={barTrack}>
                  <div class={barFill} style={{ width: `${Math.max(3, (group.costSum / maxCost()) * 100)}%` }} />
                </div>
              </div>
              <div class={right}>
                <div class={strongCell}>{group.priced ? fmtMoney(group.costSum) : '-'}</div>
                <div class={muted}>{fmtPct(group.costPercent)}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

const projectGroups = (rows: SerializedRow[]) => {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const key = row.project || '(unknown)';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        sessions: 0,
        fresh: 0,
        cache: 0,
        cost: 0,
        priced: 0,
        turns: 0,
        tools: 0,
        linesAdded: 0,
        linesDeleted: 0,
      };
      groups.set(key, group);
    }
    group.sessions++;
    group.fresh += row.freshTokens;
    group.cache += row.tokCr;
    group.turns += row.turns;
    group.tools += row.tools;
    group.linesAdded += row.linesAdded ?? 0;
    group.linesDeleted += row.linesDeleted ?? 0;
    if (row.costKnown) {
      group.cost += row.costApprox;
      group.priced++;
    }
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};

const ProjectSummary = (props: { rows: SerializedRow[] }) => (
  <Show when={projectGroups(props.rows).length} fallback={<div class={empty}>No projects</div>}>
    <div class={tableWrap}>
      <table class={cx(table, projectTable)}>
        <thead>
          <tr>
            <th>Project</th>
            <th style={{ width: '88px' }} class={right}>
              Sessions
            </th>
            <th style={{ width: '110px' }} class={right}>
              Fresh
            </th>
            <th style={{ width: '110px' }} class={right}>
              Cache
            </th>
            <th style={{ width: '96px' }} class={right}>
              $API
            </th>
            <th style={{ width: '110px' }} class={right}>
              Lines
            </th>
            <th style={{ width: '96px' }} class={right}>
              Turns
            </th>
            <th style={{ width: '96px' }} class={right}>
              Tools
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={projectGroups(props.rows)}>
            {(project) => (
              <tr>
                <td class={strongCell}>{project.key}</td>
                <td class={right}>{fmtNum(project.sessions)}</td>
                <td class={right}>{fmtNum(project.fresh)}</td>
                <td class={right}>{fmtNum(project.cache)}</td>
                <td class={right}>{project.priced ? fmtMoney(project.cost) : '-'}</td>
                <td class={right}>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
                </td>
                <td class={right}>{fmtNum(project.turns)}</td>
                <td class={right}>{fmtNum(project.tools)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

export const Dashboard = () => {
  const [query, setQuery] = createSignal('');
  const [harness, setHarness] = createSignal('all');
  const generatedAt = new Date(payload.generatedAt);
  const [dateRange, setDateRange] = createSignal<DateRangeMode>('all');
  const [customFrom, setCustomFrom] = createSignal(toDateInputValue(startOfDay(shiftCalendarDays(generatedAt, -6))));
  const [customTo, setCustomTo] = createSignal(toDateInputValue(generatedAt));
  const [sortKey, setSortKey] = createSignal<TableSortKey>(
    payload.filters.sort === 'tokens' ? 'fresh' : payload.filters.sort,
  );
  const [sortDirection, setSortDirection] = createSignal<SortDirection>('desc');
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const harnesses = createMemo(() => ['all', ...new Set(payload.rows.map((row) => row.harness))]);
  const dateBounds = createMemo(() => dateBoundsForRange(dateRange(), generatedAt, customFrom(), customTo()));
  const matchesDateRange = (row: SerializedRow) => rowMatchesDateBounds(row, dateBounds());
  const matchesCurrentFilters = (row: SerializedRow) =>
    matchesRow(row, query().trim().toLowerCase(), harness()) && matchesDateRange(row);
  const filteredRows = createMemo(() =>
    payload.rows.filter(matchesCurrentFilters).sort(compareRows(sortKey(), sortDirection())),
  );
  const displayRows = createMemo(() => filteredRows());
  const visibleSummary = createMemo(() => rowsSummary(filteredRows()));
  const modelGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => row.model));
  const providerGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => row.provider));
  const harnessGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => row.harness));
  const dateRangeLabel = createMemo(() => {
    if (dateRange() === 'all') return 'all dates';
    if (dateRange() === 'today') return 'today';
    if (dateRange() === '7d') return 'last 7 days';
    if (dateRange() === '30d') return 'last 30 days';
    return `${customFrom() || 'start'} to ${customTo() || 'end'}`;
  });
  const filteredDateSpan = createMemo(() => rowsDateSpan(filteredRows()));
  const hiddenCount = createMemo(() => payload.rows.length - filteredRows().length);
  const exportRows = createMemo(() => filteredRows());
  const selectedRow = createMemo(() => displayRows().find((row) => rowKey(row) === selectedKey()) ?? displayRows()[0]);
  createEffect(() => {
    const current = selectedRow();
    setSelectedKey(current ? rowKey(current) : null);
  });
  const handleSort = (column: TableSortKey) => {
    if (sortKey() === column) {
      setSortDirection(sortDirection() === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(column);
    setSortDirection(column === 'session' ? 'asc' : 'desc');
  };
  const metrics = createMemo<Metric[]>(() => {
    const a = visibleSummary();
    return [
      { label: 'Sessions', value: fmtNum(a.sessionCount), tone: 'mint' },
      { label: '$API', value: fmtMoney(a.totalCost), tone: 'teal' },
      { label: 'Mean', value: fmtMoney(a.meanCost), tone: 'amber' },
      { label: 'Fresh', value: fmtNum(a.fresh), tone: 'mint' },
      { label: 'Turns', value: fmtNum(a.turns), tone: 'rose' },
      { label: 'Tools', value: fmtNum(a.tools), tone: 'teal' },
    ];
  });

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={titleBlock}>
            <div class={eyebrow}>ai-usage</div>
            <h1 class={title}>Usage report</h1>
            <div class={meta}>
              Generated {fmtDate(payload.generatedAt)} · {fmtNum(filteredRows().length)} of{' '}
              {fmtNum(payload.rows.length)} sessions · {dateRangeLabel()}
            </div>
          </div>
          <div class={controls}>
            <input
              class={searchInput}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Filter sessions"
            />
            <select class={selectInput} value={harness()} onChange={(event) => setHarness(event.currentTarget.value)}>
              <For each={harnesses()}>
                {(item) => <option value={item}>{item === 'all' ? 'All harnesses' : item}</option>}
              </For>
            </select>
            <select
              class={selectInput}
              value={dateRange()}
              aria-label="Date range"
              onChange={(event) => setDateRange(event.currentTarget.value as DateRangeMode)}
            >
              <option value="all">All dates</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select>
            <Show when={dateRange() === 'custom'}>
              <input
                class={dateInput}
                type="date"
                value={customFrom()}
                aria-label="From date"
                onInput={(event) => setCustomFrom(event.currentTarget.value)}
              />
              <input
                class={dateInput}
                type="date"
                value={customTo()}
                aria-label="To date"
                onInput={(event) => setCustomTo(event.currentTarget.value)}
              />
            </Show>
            <button class={commandButton} type="button" onClick={() => downloadCSV(exportRows())}>
              Export CSV
            </button>
          </div>
        </header>

        <div class={filterSummary}>
          <span class={summaryPill}>
            {fmtNum(filteredRows().length)} / {fmtNum(payload.rows.length)} sessions
          </span>
          <span class={summaryPill}>{dateRangeLabel()}</span>
          <Show when={filteredDateSpan()}>
            {(span) => (
              <span>
                {fmtDateOnly(span().from)} to {fmtDateOnly(span().to)}
              </span>
            )}
          </Show>
          <Show when={hiddenCount() > 0}>
            <span>{fmtNum(hiddenCount())} hidden by filters</span>
          </Show>
        </div>

        <div class={metricGrid}>
          <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
        </div>

        <Tabs.Root defaultValue="sessions" class={tabsRoot}>
          <Tabs.List class={tabsList}>
            <Tabs.Trigger value="sessions" class={tabTrigger}>
              Sessions
            </Tabs.Trigger>
            <Tabs.Trigger value="models" class={tabTrigger}>
              Models
            </Tabs.Trigger>
            <Tabs.Trigger value="providers" class={tabTrigger}>
              Providers
            </Tabs.Trigger>
            <Tabs.Trigger value="harnesses" class={tabTrigger}>
              Harnesses
            </Tabs.Trigger>
            <Tabs.Trigger value="projects" class={tabTrigger}>
              Projects
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="sessions" class={section}>
            <SessionTable
              rows={displayRows()}
              selectedKey={selectedKey()}
              sortKey={sortKey()}
              sortDirection={sortDirection()}
              onSort={handleSort}
              onSelect={(row) => setSelectedKey(rowKey(row))}
            />
            <SessionDetail row={selectedRow()} />
          </Tabs.Content>
          <Tabs.Content value="models" class={section}>
            <div class={groupGrid}>
              <GroupPanel title="By model" groups={modelGroups()} />
              <GroupPanel title="Cost per model" groups={modelGroups().slice(0, 10)} />
            </div>
          </Tabs.Content>
          <Tabs.Content value="providers" class={section}>
            <GroupPanel title="By provider" groups={providerGroups()} />
          </Tabs.Content>
          <Tabs.Content value="harnesses" class={section}>
            <GroupPanel title="By harness" groups={harnessGroups()} />
          </Tabs.Content>
          <Tabs.Content value="projects" class={section}>
            <ProjectSummary rows={filteredRows()} />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </main>
  );
};
