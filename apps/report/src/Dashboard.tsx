import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { SerializedRow } from '@ai-usage/core/report-data';
import { Tabs } from '@ark-ui/solid/tabs';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { css, cx } from '../styled-system/css';
import {
  type DateRangeMode,
  dateBoundsForRange,
  parseLocalDate,
  rowMatchesDateBounds,
  rowsDateSpan,
  startOfDay,
  toDateInputValue,
} from './date-range';
import { isDemoReportPayload, readReportPayload } from './report-data';

const payload = readReportPayload();

const fmtNum = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n);
const fmtMoney = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);
const fmtPct = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`;
const fmtMaybeNum = (n: number | null | undefined) => (n == null ? '—' : fmtNum(n));
const fmtCompact = (n: number) => {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e5) return `${Math.round(n / 1e3)}k`;
  return fmtNum(n);
};
const UNKNOWN_PRICE_HINT = 'No pricing data for this model';
const fmtDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '—';
const fmtDateOnly = (value: string | Date | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      }).format(value instanceof Date ? value : new Date(value))
    : '—';

const fmtDuration = (ms: number | null) => {
  if (!ms || ms <= 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
};

// Harnesses report the same upstream model under different ids
// (gpt-5.5 vs openai/gpt-5.5); group on the bare id so one model is one line.
const normalizeModelKey = (model: string) => model.slice(model.lastIndexOf('/') + 1);

// "(OC)" is collector shorthand for sessions proxied through OpenCode.
const providerLabel = (provider: string) => provider.replace(/\s*\(OC\)\s*$/, ' · via OpenCode');

const shiftCalendarDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const page = css({
  minHeight: '100vh',
  bg: 'canvas',
  color: 'ink',
  fontFamily: 'sans',
});

const shell = css({
  maxWidth: '1380px',
  mx: 'auto',
  px: { base: '20px', md: '36px' },
  py: { base: '24px', md: '32px' },
});

const header = css({
  display: 'grid',
  gap: '20px',
  pb: '16px',
});

const headerTop = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '16px',
});

const titleBlock = css({
  display: 'grid',
  gap: '8px',
});

const eyebrowRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
});

const eyebrow = css({
  textStyle: 'eyebrow',
  color: 'accent',
});

const demoBadge = css({
  textStyle: 'label',
  display: 'inline-flex',
  alignItems: 'center',
  h: '20px',
  px: '8px',
  borderRadius: 'full',
  bg: 'accentSoft',
  color: 'accent',
});

const title = css({
  fontSize: { base: '26px', md: '30px' },
  lineHeight: '1.1',
  fontWeight: 650,
  letterSpacing: '-0.02em',
});

const meta = css({
  color: 'muted',
  fontSize: '13px',
  overflowWrap: 'anywhere',
});

const themeToggleButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '36px',
  h: '36px',
  flexShrink: 0,
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'accent',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const filterSummary = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 12px',
  alignItems: 'center',
  color: 'muted',
  fontSize: '12px',
  pt: '14px',
});

const summaryPill = css({
  textStyle: 'numeric',
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '11px',
  fontWeight: 600,
});

// Sticky so the filters stay reachable while scanning the session table.
// Static on small screens, where the stacked controls would cover too much.
const toolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: '0',
  zIndex: 20,
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  py: '12px',
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
});

const field = css({
  h: '36px',
  px: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
  _placeholder: {
    color: 'faint',
  },
  _focusVisible: {
    borderColor: 'accent',
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
});

const searchInput = cx(field, css({ flex: '1 1 240px', minW: '180px' }));
const selectInput = cx(field, css({ flex: '0 1 180px', minW: '150px' }));
const dateInput = cx(field, css({ flex: '0 1 150px', minW: '140px' }));

const commandButton = css({
  h: '36px',
  px: '16px',
  ml: 'auto',
  border: '1px solid token(colors.ink)',
  borderRadius: 'sm',
  bg: 'ink',
  color: 'canvas',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background-color 0.15s, border-color 0.15s',
  _hover: {
    bg: 'inkHover',
    borderColor: 'inkHover',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const metricGrid = css({
  display: 'grid',
  gridTemplateColumns: {
    base: 'repeat(2, minmax(0, 1fr))',
    md: 'repeat(4, minmax(0, 1fr))',
    xl: 'repeat(7, minmax(0, 1fr))',
  },
  gap: '10px',
  my: '20px',
});

const metricTile = css({
  minH: '88px',
  p: '14px 16px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  display: 'grid',
  alignContent: 'space-between',
  gap: '10px',
});

const metricLabel = css({
  textStyle: 'label',
  color: 'muted',
});

const metricValue = css({
  textStyle: 'numeric',
  fontSize: { base: '20px', md: '23px' },
  lineHeight: '1',
  fontWeight: 600,
});

const tabsRoot = css({
  display: 'grid',
  gap: '16px',
});

// Wrap instead of overflow so no tab is ever hidden on narrow screens.
const tabsList = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0 20px',
  borderBottom: '1px solid token(colors.line)',
});

const tabTrigger = css({
  appearance: 'none',
  border: '0',
  borderBottom: '2px solid transparent',
  mb: '-1px',
  bg: 'transparent',
  color: 'muted',
  px: '2px',
  py: '10px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'ink',
  },
  '&[data-selected]': {
    color: 'ink',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
});

const section = css({
  display: 'grid',
  gap: '14px',
});

// Internal scroll keeps the page short; the sticky header keeps columns
// labelled while scanning all rows.
const tableWrap = css({
  overflow: 'auto',
  maxH: 'calc(100dvh - 240px)',
  minH: '320px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const table = css({
  width: '100%',
  // Collapsed borders do not travel with sticky cells; keep them separate.
  borderCollapse: 'separate',
  borderSpacing: 0,
  minW: '1040px',
  tableLayout: 'fixed',
  fontSize: '13px',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    bg: 'surface',
    textStyle: 'label',
    color: 'muted',
    textAlign: 'left',
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
  },
  '& td': {
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
    verticalAlign: 'middle',
  },
  '& tr:last-child td': {
    borderBottom: '0',
  },
});

// Only session rows are interactive; the projects table reuses `table`
// without these affordances.
const sessionsTable = css({
  '& tbody tr': {
    cursor: 'pointer',
    transition: 'background-color 0.1s',
  },
  '& tbody tr:hover td': {
    bg: 'surfaceMuted',
  },
  '& tbody tr:focus-visible': {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
  '& tbody tr[data-selected="true"] td': {
    bg: 'accentTint',
  },
  '& tbody tr[data-selected="true"] td:first-child': {
    boxShadow: 'inset 2px 0 0 token(colors.accent)',
  },
});

const right = css({ textAlign: 'right' });
const muted = css({ color: 'muted' });
const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });
const numCell = css({
  textStyle: 'numeric',
  textAlign: 'right',
  fontSize: '12px',
});
const dateCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  lineHeight: '1.4',
  color: 'muted',
});
const sessionCell = css({ fontWeight: 600, overflowWrap: 'break-word' });

// Session labels can be entire pasted prompts; clamp them so one row stays a
// row (the expanded detail shows the full text).
const sessionTitleClamp = css({
  lineClamp: 2,
});
const modelCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
});

const sortButton = css({
  appearance: 'none',
  display: 'inline-flex',
  gap: '5px',
  alignItems: 'center',
  border: '0',
  p: '0',
  bg: 'transparent',
  color: 'inherit',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  cursor: 'pointer',
  _hover: {
    color: 'ink',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const sortArrow = css({
  color: 'accent',
  fontSize: '10px',
  lineHeight: '1',
});

const ghostButton = css({
  appearance: 'none',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  px: '12px',
  py: '5px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'border-color 0.15s, color 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

// Non-modal inspector: it overlays the right edge, the table stays
// interactive so clicking other rows just swaps its content.
const drawer = css({
  position: 'fixed',
  top: '0',
  right: '0',
  bottom: '0',
  w: { base: '100%', sm: '440px' },
  maxW: '100vw',
  display: 'flex',
  flexDirection: 'column',
  bg: 'surface',
  borderLeft: '1px solid token(colors.line)',
  boxShadow: 'overlay',
  zIndex: 40,
  animation: 'drawerIn 0.18s ease-out',
});

const drawerTop = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '10px',
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
});

const drawerBody = css({
  display: 'grid',
  gap: '14px',
  alignContent: 'start',
  p: '16px 18px',
  overflowY: 'auto',
});

const drawerTitle = css({
  fontSize: '15px',
  fontWeight: 650,
  lineHeight: '1.35',
  overflowWrap: 'anywhere',
});

const drawerGrid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '14px 12px',
});

const drawerClose = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '30px',
  h: '30px',
  flexShrink: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'transparent',
  color: 'muted',
  fontSize: '14px',
  lineHeight: '1',
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'accent',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const emptyActions = css({
  display: 'grid',
  gap: '12px',
  justifyItems: 'center',
});

const chartSpacing = css({ mb: '20px' });

// Same shell as groupHeader, but the legend drops below the title on narrow
// screens instead of crushing it.
const chartHeader = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'minmax(0, 1fr) auto' },
  gap: '10px',
  alignItems: 'center',
  p: '14px 16px',
  borderBottom: '1px solid token(colors.line)',
});

const chartBody = css({
  display: 'grid',
  gap: '8px',
  p: '14px 16px',
});

const chartPlot = css({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '2px',
  h: '140px',
});

const chartCol = css({
  flex: '1 1 0',
  minW: '2px',
  h: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: '1px',
  _hover: {
    opacity: 0.8,
  },
});

const chartSeg = css({
  w: '100%',
  borderRadius: '1px',
});

const chartAxis = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'faint',
  fontSize: '11px',
  fontFamily: 'mono',
});

const chartLegend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  justifyContent: { base: 'flex-start', sm: 'flex-end' },
});

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
const harnessFamily = (name: string) => {
  const lower = name.toLowerCase();
  return badgeTones[lower] ? lower : (lower.split(/[\s-]/)[0] ?? '');
};

const badgeToneFor = (name: string) => badgeTones[harnessFamily(name)] ?? badgeNeutral;

// Solid fills reusing the badge foreground colors, for chart segments and
// per-harness distribution bars.
const harnessFillTones: Record<string, string> = {
  claude: css({ bg: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.fg' }),
};

const harnessFillFor = (name: string) => harnessFillTones[harnessFamily(name)];

const groupPanel = css({
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  overflow: 'hidden',
});

const groupHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'center',
  p: '14px 16px',
  borderBottom: '1px solid token(colors.line)',
});

const groupTitle = css({
  fontSize: '14px',
  fontWeight: 650,
  overflowWrap: 'anywhere',
});

const groupCount = css({
  textStyle: 'numeric',
  fontSize: '11px',
  color: 'faint',
});

const groupRows = css({
  display: 'grid',
});

const groupRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 96px',
  gap: '14px',
  alignItems: 'center',
  px: '16px',
  py: '12px',
  borderBottom: '1px solid token(colors.line)',
  _last: {
    borderBottom: '0',
  },
});

const groupSub = css({
  color: 'muted',
  fontSize: '12px',
  mt: '2px',
});

const groupValue = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 600,
});

const groupPct = css({
  textStyle: 'numeric',
  fontSize: '11px',
  color: 'muted',
  mt: '2px',
});

const barTrack = css({
  h: '6px',
  mt: '8px',
  borderRadius: 'full',
  bg: 'track',
  overflow: 'hidden',
});

// Color is applied separately so harness tones can replace the accent
// without two atomic `bg` classes fighting over cascade order.
const barFill = css({
  h: '100%',
  borderRadius: 'full',
});

const accentFill = css({ bg: 'accent' });

const empty = css({
  minH: '160px',
  display: 'grid',
  placeItems: 'center',
  color: 'muted',
  fontSize: '13px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
});

const unavailablePanel = css({
  mt: '20px',
  minH: '180px',
  display: 'grid',
  alignContent: 'center',
  gap: '8px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  p: '22px',
});

const unavailableTitle = css({
  fontSize: '16px',
  fontWeight: 650,
});

const unavailableText = css({
  color: 'muted',
  fontSize: '13px',
  maxW: '620px',
});

const detailItem = css({
  display: 'grid',
  gap: '5px',
  minW: '0',
});

const detailLabel = css({
  textStyle: 'label',
  color: 'muted',
});

const detailValue = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
});

const projectTable = css({
  minW: '780px',
});

type Metric = {
  label: string;
  value: string;
  hint?: string;
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

const MetricTile = (props: Metric) => (
  <div class={metricTile} title={props.hint}>
    <div class={metricLabel}>{props.label}</div>
    <div class={metricValue}>{props.value}</div>
  </div>
);

const HarnessBadge = (props: { name: string }) => <span class={cx(badge, badgeToneFor(props.name))}>{props.name}</span>;

const THEME_STORAGE_KEY = 'ai-usage-theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

const storedTheme = (): 'light' | 'dark' | null => {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
};

const SunIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4.4" />
    <path d="M12 2.2v2.6M12 19.2v2.6M21.8 12h-2.6M4.8 12H2.2M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8M18.9 18.9l-1.8-1.8M6.9 6.9 5.1 5.1" />
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.6 14.4A8.7 8.7 0 0 1 9.6 3.4a8.7 8.7 0 1 0 11 11Z" />
  </svg>
);

// Two-state toggle: follow the OS by default, pin the opposite scheme on
// click. A pin that lands back on the OS value clears to auto, so the report
// keeps tracking system changes unless the user actually diverges from them.
const ThemeToggle = () => {
  const [theme, setTheme] = createSignal<'light' | 'dark'>(storedTheme() ?? (prefersDark.matches ? 'dark' : 'light'));
  const handleSystemChange = (event: MediaQueryListEvent) => {
    if (!storedTheme()) setTheme(event.matches ? 'dark' : 'light');
  };
  prefersDark.addEventListener('change', handleSystemChange);
  onCleanup(() => prefersDark.removeEventListener('change', handleSystemChange));

  const toggle = () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    const followsSystem = next === (prefersDark.matches ? 'dark' : 'light');
    setTheme(next);
    try {
      if (followsSystem) localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Without storage the pin still applies for the lifetime of the page.
    }
    if (followsSystem) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', followsSystem ? 'light dark' : next);
  };

  return (
    <button
      class={themeToggleButton}
      type="button"
      onClick={toggle}
      aria-label={theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Show when={theme() === 'dark'} fallback={<SunIcon />}>
        <MoonIcon />
      </Show>
    </button>
  );
};

const rowKey = (row: SerializedRow) =>
  [row.activeDate ?? row.date ?? '', row.harness, row.provider, row.model, row.project, row.sessionLabel].join('|');

const matchesRow = (row: SerializedRow, query: string, harness: string) => {
  const haystack =
    `${row.sessionLabel} ${row.project} ${row.model} ${row.provider} ${providerLabel(row.provider)} ${row.harness}`.toLowerCase();
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
    actualCost: rows.reduce((sum, row) => sum + (row.costActual ?? 0), 0),
    unknownActual: rows.filter((row) => row.costActual == null).length,
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
      <span class={sortArrow} aria-hidden="true">
        {props.direction === 'asc' ? '↑' : '↓'}
      </span>
    </Show>
  </button>
);

const DetailItem = (props: { label: string; value: string; hint?: string }) => (
  <div class={detailItem} title={props.hint}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const SessionDrawer = (props: { row: SerializedRow; onClose: () => void }) => (
  <aside class={drawer} aria-label="Session details">
    <div class={drawerTop}>
      <HarnessBadge name={props.row.harness} />
      <button class={drawerClose} type="button" aria-label="Close session details" onClick={() => props.onClose()}>
        ✕
      </button>
    </div>
    <div class={drawerBody}>
      <div>
        <div class={drawerTitle}>{props.row.sessionLabel}</div>
        <div class={muted}>
          {providerLabel(props.row.provider)} · {props.row.model}
        </div>
      </div>
      <div class={drawerGrid}>
        <DetailItem label="Started" value={fmtDate(props.row.date)} />
        <DetailItem label="Ended" value={fmtDate(props.row.endDate)} />
        <DetailItem label="Input" value={fmtNum(props.row.tokIn)} />
        <DetailItem label="Output" value={fmtNum(props.row.tokOut)} />
        <DetailItem label="Cache read" value={fmtNum(props.row.tokCr)} />
        <DetailItem label="Cache write" value={fmtNum(props.row.tokCw)} />
        <DetailItem label="Total tokens" value={fmtNum(props.row.tokenTotal)} />
        <DetailItem
          label="API value"
          value={props.row.costKnown ? fmtMoney(props.row.costApprox) : '—'}
          hint={props.row.costKnown ? 'Estimated cost at standard API prices' : UNKNOWN_PRICE_HINT}
        />
        <DetailItem
          label="Actual cost"
          value={fmtMoney(props.row.costActual)}
          hint="Out-of-pocket spend — $0.00 means covered by a subscription"
        />
        <DetailItem label="Calls" value={fmtNum(props.row.calls)} />
        <DetailItem label="Turns" value={fmtNum(props.row.turns)} />
        <DetailItem label="Tools" value={fmtNum(props.row.tools)} />
        <DetailItem label="Duration" value={fmtDuration(props.row.durationMs)} />
        <DetailItem label="Lines" value={lineDeltaLabel(props.row)} />
        <DetailItem label="Subagent" value={props.row.subagent ? 'Yes' : 'No'} />
        <DetailItem label="Partial" value={props.row.partial ? 'Yes' : 'No'} />
      </div>
    </div>
  </aside>
);

const SessionTable = (props: {
  rows: SerializedRow[];
  selectedKey: string | null;
  sortKey: TableSortKey;
  sortDirection: SortDirection;
  onSort: (column: TableSortKey) => void;
  onSelect: (row: SerializedRow) => void;
  onClearFilters: () => void;
}) => (
  <Show
    when={props.rows.length}
    fallback={
      <div class={empty}>
        <div class={emptyActions}>
          <span>No sessions match the current filters</span>
          <button class={ghostButton} type="button" onClick={() => props.onClearFilters()}>
            Clear filters
          </button>
        </div>
      </div>
    }
  >
    <div class={tableWrap}>
      <table class={cx(table, sessionsTable)}>
        <thead>
          <tr>
            <th style={{ width: '104px' }}>
              <SortHeader
                label="Date"
                column="date"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
              />
            </th>
            <th style={{ width: '100px' }}>Harness</th>
            <th style={{ width: '124px' }}>Provider</th>
            <th style={{ width: '168px' }}>Model</th>
            <th style={{ width: '120px' }}>Project</th>
            <th
              style={{ width: '84px' }}
              class={right}
              title="Tokens processed without cache (input + output + cache writes)"
            >
              <SortHeader
                label="Fresh"
                column="fresh"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '84px' }} class={right} title="Cache-read tokens">
              <SortHeader
                label="Cache"
                column="cache"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '76px' }} class={right} title="Estimated cost at standard API prices">
              <SortHeader
                label="$API"
                column="cost"
                current={props.sortKey}
                direction={props.sortDirection}
                onSort={props.onSort}
                class={right}
              />
            </th>
            <th style={{ width: '68px' }} class={right} title="Wall-clock session duration">
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
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr
                data-selected={String(props.selectedKey === rowKey(row))}
                tabIndex={0}
                onClick={() => props.onSelect(row)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  props.onSelect(row);
                }}
              >
                <td class={dateCell}>{fmtDate(row.activeDate)}</td>
                <td>
                  <HarnessBadge name={row.harness} />
                </td>
                <td>{providerLabel(row.provider)}</td>
                <td class={modelCell}>{row.model}</td>
                <td>{row.project || '—'}</td>
                <td class={numCell} title={fmtNum(row.freshTokens)}>
                  {fmtCompact(row.freshTokens)}
                </td>
                <td class={numCell} title={fmtNum(row.tokCr)}>
                  {fmtCompact(row.tokCr)}
                </td>
                <td class={numCell}>
                  <Show when={row.costKnown} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                    {fmtMoney(row.costApprox)}
                  </Show>
                </td>
                <td class={numCell}>{fmtDuration(row.durationMs)}</td>
                <td class={sessionCell}>
                  <div class={sessionTitleClamp}>{row.sessionLabel}</div>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

const GroupPanel = (props: { title: string; groups: AnalyticsGroup[]; countLabel: string; harnessTones?: boolean }) => {
  const maxCost = createMemo(() => Math.max(1, ...props.groups.map((group) => group.costSum)));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <div class={groupCount} title={`${props.groups.length} ${props.countLabel}`}>
          {props.groups.length} {props.countLabel}
        </div>
      </div>
      <div class={groupRows}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <div>
                <div class={strongCell}>{group.key}</div>
                <div class={groupSub} title={`${fmtNum(group.fresh)} fresh tokens`}>
                  {group.sessions} sess · {fmtCompact(group.fresh)} fresh · {fmtPct(group.cacheHitPct)} cache
                </div>
                <div class={barTrack}>
                  <div
                    class={cx(barFill, (props.harnessTones ? harnessFillFor(group.harness) : undefined) ?? accentFill)}
                    style={{ width: `${Math.max(3, (group.costSum / maxCost()) * 100)}%` }}
                  />
                </div>
              </div>
              <div class={right}>
                <div class={groupValue}>
                  <Show when={group.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                    {fmtMoney(group.costSum)}
                  </Show>
                </div>
                <div class={groupPct}>{fmtPct(group.costPercent)}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

const DAY_MS = 86_400_000;

type TimelinePart = { harness: string; cost: number };
type TimelineBucket = { date: Date; total: number; parts: TimelinePart[] };

const timelineBucketTitle = (bucket: TimelineBucket, weekly: boolean) =>
  [
    `${weekly ? 'Week of ' : ''}${fmtDateOnly(bucket.date)} — ${fmtMoney(bucket.total)}`,
    ...bucket.parts.map((part) => `${part.harness} ${fmtMoney(part.cost)}`),
  ].join('\n');

const CostTimeline = (props: { rows: SerializedRow[] }) => {
  const data = createMemo(() => {
    const priced = props.rows.filter((row) => row.costKnown && (row.activeDate ?? row.date));
    if (!priced.length) return null;
    const times = priced.map((row) => new Date(row.activeDate ?? row.date ?? 0).getTime());
    const minDay = startOfDay(new Date(Math.min(...times)));
    const maxDay = startOfDay(new Date(Math.max(...times)));
    const dayCount = Math.round((maxDay.getTime() - minDay.getTime()) / DAY_MS) + 1;
    // Weekly buckets past ~4 months keep the bars readable (and the DOM small).
    const weekly = dayCount > 120;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const buckets = new Map<string, TimelineBucket & { byHarness: Map<string, number> }>();
    for (let cursor = bucketStart(minDay); cursor <= maxDay; cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)) {
      buckets.set(toDateInputValue(cursor), { date: cursor, total: 0, parts: [], byHarness: new Map() });
    }
    const harnessTotals = new Map<string, number>();
    for (const row of priced) {
      const bucket = buckets.get(toDateInputValue(bucketStart(new Date(row.activeDate ?? row.date ?? 0))));
      if (!bucket) continue;
      bucket.total += row.costApprox;
      bucket.byHarness.set(row.harness, (bucket.byHarness.get(row.harness) ?? 0) + row.costApprox);
      harnessTotals.set(row.harness, (harnessTotals.get(row.harness) ?? 0) + row.costApprox);
    }
    const harnesses = [...harnessTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const list = [...buckets.values()].map((bucket) => ({
      date: bucket.date,
      total: bucket.total,
      parts: harnesses
        .map((name) => ({ harness: name, cost: bucket.byHarness.get(name) ?? 0 }))
        .filter((part) => part.cost > 0),
    }));
    const maxTotal = Math.max(...list.map((bucket) => bucket.total));
    if (maxTotal <= 0) return null;
    return { list, maxTotal, weekly, harnesses };
  });

  return (
    <Show when={data()}>
      {(chart) => (
        <section class={cx(groupPanel, chartSpacing)} aria-label="Cost over time">
          <div class={chartHeader}>
            <div>
              <div class={groupTitle}>Cost over time</div>
              <div class={groupSub}>
                API value per {chart().weekly ? 'week' : 'day'} · peak {fmtMoney(chart().maxTotal)}
              </div>
            </div>
            <div class={chartLegend}>
              <For each={chart().harnesses}>{(name) => <HarnessBadge name={name} />}</For>
            </div>
          </div>
          <div class={chartBody}>
            <div class={chartPlot}>
              <For each={chart().list}>
                {(bucket) => (
                  <div class={chartCol} title={timelineBucketTitle(bucket, chart().weekly)}>
                    <For each={bucket.parts}>
                      {(part) => (
                        <div
                          class={cx(chartSeg, harnessFillFor(part.harness) ?? accentFill)}
                          style={{ height: `${(part.cost / chart().maxTotal) * 100}%` }}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <div class={chartAxis}>
              <span>{fmtDateOnly(chart().list[0]?.date ?? null)}</span>
              <span>{fmtDateOnly(chart().list[chart().list.length - 1]?.date ?? null)}</span>
            </div>
          </div>
        </section>
      )}
    </Show>
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
                <td
                  class={strongCell}
                  title={project.key === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                >
                  {project.key}
                </td>
                <td class={numCell}>{fmtNum(project.sessions)}</td>
                <td class={numCell} title={fmtNum(project.fresh)}>
                  {fmtCompact(project.fresh)}
                </td>
                <td class={numCell} title={fmtNum(project.cache)}>
                  {fmtCompact(project.cache)}
                </td>
                <td class={numCell}>
                  <Show when={project.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                    {fmtMoney(project.cost)}
                  </Show>
                </td>
                <td class={numCell}>
                  +{fmtNum(project.linesAdded)}/-{fmtNum(project.linesDeleted)}
                </td>
                <td class={numCell}>{fmtNum(project.turns)}</td>
                <td class={numCell}>{fmtNum(project.tools)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </Show>
);

export const Dashboard = () => {
  const isDemo = isDemoReportPayload();
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
  // The drawer closes by itself when its row leaves the filtered set.
  const selectedRow = createMemo(() => filteredRows().find((row) => rowKey(row) === selectedKey()) ?? null);
  createEffect(() => {
    if (!selectedRow()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedKey(null);
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  const visibleSummary = createMemo(() => rowsSummary(filteredRows()));
  const modelGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => normalizeModelKey(row.model)));
  const providerGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => providerLabel(row.provider)));
  const harnessGroups = createMemo(() => analyticsGroups(filteredRows(), (row) => row.harness));
  const dateRangeLabel = createMemo(() => {
    if (dateRange() === 'all') return 'all dates';
    if (dateRange() === 'today') return 'today';
    if (dateRange() === '7d') return 'last 7 days';
    if (dateRange() === '30d') return 'last 30 days';
    const from = customFrom() ? fmtDateOnly(parseLocalDate(customFrom())) : 'start';
    const to = customTo() ? fmtDateOnly(parseLocalDate(customTo(), true)) : 'end';
    return `${from} – ${to}`;
  });
  const filteredDateSpan = createMemo(() => rowsDateSpan(filteredRows()));
  const hiddenCount = createMemo(() => payload.rows.length - filteredRows().length);
  const exportRows = createMemo(() => filteredRows());
  const toggleSelected = (row: SerializedRow) =>
    setSelectedKey((current) => (current === rowKey(row) ? null : rowKey(row)));
  const clearFilters = () => {
    setQuery('');
    setHarness('all');
    setDateRange('all');
  };
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
      { label: 'Sessions', value: fmtNum(a.sessionCount), hint: 'Sessions in the current filter' },
      {
        label: 'API value',
        value: fmtMoney(a.totalCost),
        hint: 'Estimated cost at standard API prices, including usage covered by subscriptions',
      },
      {
        label: 'Actual cost',
        value: fmtMoney(a.actualCost),
        hint: `Out-of-pocket spend reported by harnesses; subscription usage counts as $0${
          a.unknownActual ? ` (${fmtNum(a.unknownActual)} sessions unknown)` : ''
        }`,
      },
      { label: 'Mean / sess', value: fmtMoney(a.meanCost), hint: 'Mean API value per priced session' },
      { label: 'Fresh tokens', value: fmtCompact(a.fresh), hint: `Tokens processed without cache: ${fmtNum(a.fresh)}` },
      { label: 'Turns', value: fmtNum(a.turns), hint: 'Assistant turns across the filtered sessions' },
      { label: 'Tool calls', value: fmtNum(a.tools), hint: 'Tool invocations across the filtered sessions' },
    ];
  });

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
            <div class={titleBlock}>
              <div class={eyebrowRow}>
                <div class={eyebrow}>ai-usage</div>
                <Show when={isDemoReportPayload()}>
                  <span class={demoBadge}>Demo data</span>
                </Show>
              </div>
              <h1 class={title}>Usage report</h1>
              <div class={meta}>
                <Show when={!isDemo} fallback="Report payload unavailable">
                  Generated {fmtDate(payload.generatedAt)} · {fmtNum(filteredRows().length)} of{' '}
                  {fmtNum(payload.rows.length)} sessions · {dateRangeLabel()}
                </Show>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <Show when={!isDemo}>
          <div class={toolbar}>
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
        </Show>

        <Show
          when={!isDemo}
          fallback={
            <section class={unavailablePanel}>
              <div class={unavailableTitle}>Real report data is not loaded</div>
              <div class={unavailableText}>
                The CLI payload was not injected into this page, so usage metrics are hidden instead of showing demo
                fixture data.
              </div>
            </section>
          }
        >
          <div class={filterSummary}>
            <span class={summaryPill}>
              {fmtNum(filteredRows().length)} / {fmtNum(payload.rows.length)} sessions
            </span>
            <span class={summaryPill}>{dateRangeLabel()}</span>
            <Show when={filteredDateSpan()}>
              {(span) => (
                <span title="First and last session in the current filter">
                  data {fmtDateOnly(span().from)} – {fmtDateOnly(span().to)}
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

          <CostTimeline rows={filteredRows()} />

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
                rows={filteredRows()}
                selectedKey={selectedKey()}
                sortKey={sortKey()}
                sortDirection={sortDirection()}
                onSort={handleSort}
                onSelect={toggleSelected}
                onClearFilters={clearFilters}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class={section}>
              <GroupPanel title="By model" groups={modelGroups()} countLabel="models" />
            </Tabs.Content>
            <Tabs.Content value="providers" class={section}>
              <GroupPanel title="By provider" groups={providerGroups()} countLabel="providers" harnessTones />
            </Tabs.Content>
            <Tabs.Content value="harnesses" class={section}>
              <GroupPanel title="By harness" groups={harnessGroups()} countLabel="harnesses" harnessTones />
            </Tabs.Content>
            <Tabs.Content value="projects" class={section}>
              <ProjectSummary rows={filteredRows()} />
            </Tabs.Content>
          </Tabs.Root>

          <Show when={selectedRow()}>
            {(row) => <SessionDrawer row={row()} onClose={() => setSelectedKey(null)} />}
          </Show>
        </Show>
      </div>
    </main>
  );
};
