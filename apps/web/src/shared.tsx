import { cx } from '@ai-usage/design-system/css';
import { segmentBarPart, segmentBarTrack, unavailableCell } from '@ai-usage/design-system/report';
import { modelGroupKey } from '@ai-usage/report-core/model-identity';
import { enrichSessionPresentationRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { For } from 'solid-js';

export {
  accentFill,
  badgeToneFor,
  HarnessBadge,
  harnessFamily,
  harnessFillFor,
  harnessSvgFillFor,
  tokenSegmentClasses,
} from '@ai-usage/design-system/report';

const numberFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
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
  if (Math.abs(n) >= 1e9) {
    return `${(n / 1e9).toFixed(2)}B`;
  }
  if (Math.abs(n) >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1e5) {
    return `${Math.round(n / 1e3)}k`;
  }
  return fmtNum(n);
};
export const UNKNOWN_PRICE_HINT = 'No pricing data for this model';
export const PARTIAL_PRICE_HINT = 'Known API-value subtotal; one or more model prices are unavailable';
export const USAGE_UNAVAILABLE_HINT = 'Session found in prompt history; detailed local token counters are missing';
export const fmtDate = (value: string | null) => (value ? dateTimeFormatter.format(new Date(value)) : '—');
export const fmtDateOnly = (value: string | Date | null) =>
  value ? dateOnlyFormatter.format(value instanceof Date ? value : new Date(value)) : '—';

export const fmtDuration = (ms: number | null) => {
  if (!ms || ms <= 0) {
    return '—';
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) {
    return `${minutes}m`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

export const median = (values: number[]) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

// Harnesses report the same upstream model under different ids and mode suffixes
// (gpt-5.4 vs openai/gpt-5.4-high); group on the shared base model.
export const normalizeModelKey = (model: string) => modelGroupKey(model);

// "(OC)" is collector shorthand for sessions proxied through OpenCode.
const OPENCODE_PROVIDER_SUFFIX = /\s*\(OC\)\s*$/;

export const providerLabel = (provider: string) => provider.replace(OPENCODE_PROVIDER_SUFFIX, ' · via OpenCode');

export type DashboardRow = SessionPresentationRow;

export interface ApiValuePresentation {
  label: string;
  status: 'exact' | 'lower-bound' | 'unknown';
  title: string;
}

export const apiValuePresentation = (row: { costApprox: number; costKnown: boolean }): ApiValuePresentation => {
  if (row.costKnown) {
    return { label: fmtMoney(row.costApprox), status: 'exact', title: 'Estimated API value at standard prices' };
  }
  if (row.costApprox > 0) {
    return { label: `≥ ${fmtMoney(row.costApprox)}`, status: 'lower-bound', title: PARTIAL_PRICE_HINT };
  }
  return { label: '—', status: 'unknown', title: UNKNOWN_PRICE_HINT };
};

export const enrichReportRow = enrichSessionPresentationRow;

export const rowKey = (row: DashboardRow) => row.rowId;

export interface ReportSummary {
  actualCost: number;
  cacheRead: number;
  cacheWrite: number;
  costQuota: number;
  fresh: number;
  meanCost: number;
  pricedSessions: number;
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
}

const createReportSummary = (): ReportSummary => ({
  actualCost: 0,
  costQuota: 0,
  cacheRead: 0,
  cacheWrite: 0,
  fresh: 0,
  meanCost: 0,
  pricedSessions: 0,
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
    if (!acceptsRow(row)) {
      continue;
    }
    summary.sessionCount++;
    if (row.costKnown) {
      summary.totalCost += row.costApprox;
      pricedCount++;
      summary.pricedSessions++;
    }
    summary.actualCost += row.costActual ?? 0;
    summary.costQuota += row.costQuota ?? 0;
    if (row.costActual == null) {
      summary.unknownActual++;
    }
    summary.fresh += row.freshTokens;
    summary.cacheRead += row.tokCr;
    summary.cacheWrite += row.tokCw;
    summary.tokIn += row.tokIn;
    summary.tokOut += row.tokOut;
    summary.rtkSaved += row.rtkSavedTokens ?? 0;
    summary.rtkInput += row.rtkInputTokens ?? 0;
    summary.rtkOutput += row.rtkOutputTokens ?? 0;
    if (row.rtkSavedTokens) {
      summary.rtkSessions++;
    }
    summary.turns += row.turns;
    summary.tools += row.tools;
  }

  summary.meanCost = summary.totalCost / (pricedCount || 1);
  return summary;
};

export interface BarSegment {
  class: string;
  label: string;
  title?: string;
  value: number;
}

export const UsageUnavailableCell = () => (
  <span class={unavailableCell} title={USAGE_UNAVAILABLE_HINT}>
    n/a
  </span>
);

// Proportional horizontal bar: token anatomy in the drawer and the overview.
export const SegmentBar = (props: { segments: BarSegment[]; ariaLabel?: string }) => {
  const total = () => props.segments.reduce((sum, segment) => sum + segment.value, 0);
  const visibleSegments = () => props.segments.filter((segment) => segment.value > 0);
  return (
    <div aria-label={props.ariaLabel} class={segmentBarTrack} role="img">
      <For each={visibleSegments()}>
        {(segment) => (
          <div
            class={cx(segmentBarPart, segment.class)}
            style={{ width: `${(segment.value / Math.max(1, total())) * 100}%` }}
            title={segment.title ?? `${segment.label}: ${fmtNum(segment.value)}`}
          />
        )}
      </For>
    </div>
  );
};
