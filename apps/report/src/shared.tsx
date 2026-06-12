import type { SerializedRow } from '@ai-usage/core/report-data';
import { css, cx } from '../styled-system/css';

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
  modelKey: string;
  projectKey: string;
  providerDisplay: string;
  rowId: string;
  searchText: string;
  sortDate: number;
  sortHarness: string;
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
  [row.activeDate ?? row.date ?? '', row.harness, row.provider, row.model, row.project, row.sessionLabel].join('|');

export const enrichReportRow = (row: SerializedRow): DashboardRow => {
  const activeTime = timeFromRowDate(row);
  const modelKey = normalizeModelKey(row.model);
  const projectKey = row.project || '(unknown)';
  const providerDisplay = providerLabel(row.provider);

  return {
    ...row,
    activeTime,
    modelKey,
    projectKey,
    providerDisplay,
    rowId: buildRowId(row),
    searchText:
      `${row.sessionLabel} ${row.project} ${row.model} ${row.provider} ${providerDisplay} ${row.harness}`.toLowerCase(),
    sortDate: activeTime ?? 0,
    sortHarness: row.harness.toLowerCase(),
    sortModel: modelKey.toLowerCase(),
    sortProject: projectKey.toLowerCase(),
    sortProvider: providerDisplay.toLowerCase(),
    sortSession: row.sessionLabel.toLowerCase(),
  };
};

export const rowKey = (row: DashboardRow) => row.rowId;

const badge = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  h: '22px',
  px: '9px',
  borderRadius: 'full',
  fontSize: '11px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  _before: {
    content: '""',
    w: '6px',
    h: '6px',
    borderRadius: 'full',
    bg: 'currentColor',
  },
});

const badgeButton = css({
  appearance: 'none',
  border: '0',
  cursor: 'pointer',
  transition: 'box-shadow 0.15s, transform 0.15s',
  _hover: {
    boxShadow: '0 0 0 1px token(colors.accent)',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const badgeActive = css({
  boxShadow: '0 0 0 1.5px token(colors.accent)',
});

const badgeTones: Record<string, string> = {
  claude: css({ bg: 'harness.claude.bg', color: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.bg', color: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.bg', color: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.bg', color: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.bg', color: 'harness.gemini.fg' }),
};

const badgeNeutral = css({ bg: 'surfaceMuted', color: 'muted' });

// Harness labels are display strings ("Claude Code", "Codex"); tone keys match
// on the first word so new label variants keep their family color.
export const harnessFamily = (name: string) => {
  const lower = name.toLowerCase();
  return badgeTones[lower] ? lower : (lower.split(/[\s-]/)[0] ?? '');
};

export const badgeToneFor = (name: string) => badgeTones[harnessFamily(name)] ?? badgeNeutral;

// Solid fills reusing the badge foreground colors, for chart segments and
// per-harness distribution bars.
const harnessFillTones: Record<string, string> = {
  claude: css({ bg: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.fg' }),
};

export const harnessFillFor = (name: string) => harnessFillTones[harnessFamily(name)];

// SVG counterparts of the harness fills (scatter plot points).
const harnessSvgFillTones: Record<string, string> = {
  claude: css({ fill: 'harness.claude.fg' }),
  codex: css({ fill: 'harness.codex.fg' }),
  cursor: css({ fill: 'harness.cursor.fg' }),
  opencode: css({ fill: 'harness.opencode.fg' }),
  gemini: css({ fill: 'harness.gemini.fg' }),
};

const harnessSvgFillNeutral = css({ fill: 'muted' });

export const harnessSvgFillFor = (name: string) => harnessSvgFillTones[harnessFamily(name)] ?? harnessSvgFillNeutral;

export const accentFill = css({ bg: 'accent' });

export const HarnessBadge = (props: { name: string; onClick?: () => void; active?: boolean; title?: string }) => {
  const className = () =>
    cx(
      badge,
      badgeToneFor(props.name),
      props.onClick ? badgeButton : undefined,
      props.active ? badgeActive : undefined,
    );
  if (!props.onClick) return <span class={className()}>{props.name}</span>;
  return (
    <button
      class={className()}
      type="button"
      title={props.title ?? `Filter by ${props.name}`}
      aria-pressed={props.active === undefined ? undefined : props.active}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.();
      }}
    >
      {props.name}
    </button>
  );
};

export type ReportSummary = {
  actualCost: number;
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

const segmentBarTrack = css({
  display: 'flex',
  h: '10px',
  borderRadius: 'full',
  bg: 'track',
  overflow: 'hidden',
});

const segmentBarPart = css({
  h: '100%',
  minW: '0',
});

export type BarSegment = { label: string; value: number; class: string; title?: string };

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

// Opacity ladder over the copper accent keeps the anatomy readable in both
// schemes without minting four new tokens.
export const tokenSegmentClasses = {
  cacheRead: cx(accentFill, css({ opacity: 0.22 })),
  cacheWrite: cx(accentFill, css({ opacity: 0.42 })),
  input: cx(accentFill, css({ opacity: 0.68 })),
  output: accentFill,
};
