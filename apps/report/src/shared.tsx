import type { SerializedRow } from '@ai-usage/core/report-data';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  badgeToneFor,
  HarnessBadge,
  harnessFamily,
  harnessFillFor,
  harnessSvgFillFor,
  segmentBarPart,
  segmentBarTrack,
  tokenSegmentClasses,
  unavailableCell,
} from '@ai-usage/design-system/report';

const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnlyFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
});

export const fmtNum = (n: number) => numberFormatter.format(n);
export const fmtMoney = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);
export const fmtPct = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`;
export const fmtMaybeNum = (n: number | null | undefined) => (n == null ? '—' : fmtNum(n));
export const fmtCompact = (n: number) => {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e5) return `${Math.round(n / 1e3)}k`;
  return fmtNum(n);
};
export const UNKNOWN_PRICE_HINT = 'No pricing data for this model';
export const USAGE_UNAVAILABLE_HINT = 'Session found in prompt history; detailed local token counters are missing';
export const fmtDate = (value: string | null) => (value ? dateTimeFormatter.format(new Date(value)) : '—');
export const fmtDateOnly = (value: string | Date | null) =>
  value ? dateOnlyFormatter.format(value instanceof Date ? value : new Date(value)) : '—';

export const fmtDuration = (ms: number | null) => {
  if (!ms || ms <= 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
};

export const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

// Harnesses report the same upstream model under different ids
// (gpt-5.5 vs openai/gpt-5.5); group on the bare id so one model is one line.
export const normalizeModelKey = (model: string) => model.slice(model.lastIndexOf('/') + 1);

// "(OC)" is collector shorthand for sessions proxied through OpenCode.
export const providerLabel = (provider: string) => provider.replace(/\s*\(OC\)\s*$/, ' · via OpenCode');

export type DashboardRow = SerializedRow & {
  activeTime: number | null;
  modelLabel: string;
  modelKey: string;
  projectKey: string;
  providerDisplay: string;
  rowId: string;
  searchText: string;
  sortDate: number;
  sortHarness: string;
  sortMachine: string;
  sortModel: string;
  sortProject: string;
  sortProvider: string;
  sortSession: string;
};

const timeFromRowDate = (row: SerializedRow) => {
  const value = row.activeDate ?? row.date;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const buildRowId = (row: SerializedRow) =>
  [
    row.activeDate ?? row.date ?? '',
    row.harness,
    row.provider,
    row.model,
    row.models?.join('+') ?? '',
    row.project,
    row.sessionLabel,
  ].join('|');

const modelLabelForRow = (row: SerializedRow) => (row.models?.length ? row.models.join(' + ') : row.model);

export const enrichReportRow = (row: SerializedRow): DashboardRow => {
  const activeTime = timeFromRowDate(row);
  const modelLabel = modelLabelForRow(row);
  const modelKey = normalizeModelKey(row.model);
  const projectKey = row.project || '(unknown)';
  const providerDisplay = providerLabel(row.provider);
  const machineLabel = row.source?.machineLabel ?? '';

  return {
    ...row,
    activeTime,
    modelLabel,
    modelKey,
    projectKey,
    providerDisplay,
    rowId: buildRowId(row),
    searchText:
      `${row.sessionLabel} ${row.project} ${modelLabel} ${row.provider} ${providerDisplay} ${row.harness} ${machineLabel}`.toLowerCase(),
    sortDate: activeTime ?? 0,
    sortHarness: row.harness.toLowerCase(),
    sortMachine: machineLabel.toLowerCase(),
    sortModel: modelKey.toLowerCase(),
    sortProject: projectKey.toLowerCase(),
    sortProvider: providerDisplay.toLowerCase(),
    sortSession: row.sessionLabel.toLowerCase(),
  };
};

export const rowKey = (row: DashboardRow) => row.rowId;

// Re-export design-system primitives used by the app.
export {
  accentFill,
  badgeToneFor,
  HarnessBadge,
  harnessFamily,
  harnessFillFor,
  harnessSvgFillFor,
  tokenSegmentClasses,
};

export type ReportSummary = {
  actualCost: number;
  costQuota: number;
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  meanCost: number;
  rtkInput: number;
  rtkOutput: number;
  rtkSaved: number;
  rtkSessions: number;
  sessionCount: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  totalCost: number;
  turns: number;
  unknownActual: number;
};

const createReportSummary = (): ReportSummary => ({
  actualCost: 0,
  costQuota: 0,
  cacheRead: 0,
  cacheWrite: 0,
  fresh: 0,
  meanCost: 0,
  rtkInput: 0,
  rtkOutput: 0,
  rtkSaved: 0,
  rtkSessions: 0,
  sessionCount: 0,
  tokIn: 0,
  tokOut: 0,
  tools: 0,
  totalCost: 0,
  turns: 0,
  unknownActual: 0,
});

export const buildReportSummary = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const summary = createReportSummary();
  let pricedCount = 0;

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    summary.sessionCount++;
    if (row.costKnown) {
      summary.totalCost += row.costApprox;
      pricedCount++;
    }
    summary.actualCost += row.costActual ?? 0;
    summary.costQuota += row.costQuota ?? 0;
    if (row.costActual == null) summary.unknownActual++;
    summary.fresh += row.freshTokens;
    summary.cacheRead += row.tokCr;
    summary.cacheWrite += row.tokCw;
    summary.tokIn += row.tokIn;
    summary.tokOut += row.tokOut;
    summary.rtkSaved += row.rtkSavedTokens ?? 0;
    summary.rtkInput += row.rtkInputTokens ?? 0;
    summary.rtkOutput += row.rtkOutputTokens ?? 0;
    if (row.rtkSavedTokens) summary.rtkSessions++;
    summary.turns += row.turns;
    summary.tools += row.tools;
  }

  summary.meanCost = summary.totalCost / (pricedCount || 1);
  return summary;
};

export type BarSegment = { label: string; value: number; class: string; title?: string };

export const UsageUnavailableCell = () => (
  <span class={unavailableCell} title={USAGE_UNAVAILABLE_HINT}>
    n/a
  </span>
);

// Proportional horizontal bar: token anatomy in the drawer and the overview.
export const SegmentBar = (props: { segments: BarSegment[]; ariaLabel?: string }) => {
  const total = () => props.segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div class={segmentBarTrack} role="img" aria-label={props.ariaLabel}>
      {props.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            class={cx(segmentBarPart, segment.class)}
            style={{ width: `${(segment.value / Math.max(1, total())) * 100}%` }}
            title={segment.title ?? `${segment.label}: ${fmtNum(segment.value)}`}
          />
        ))}
    </div>
  );
};
