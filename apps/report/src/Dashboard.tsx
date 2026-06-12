import type { AnalyticsGroup } from '@ai-usage/core/analytics';
import type { SerializedRow } from '@ai-usage/core/report-data';
import { Slider } from '@ark-ui/solid/slider';
import { Tabs } from '@ark-ui/solid/tabs';
import { useNavigate, useSearch } from '@tanstack/solid-router';
import {
  type Column,
  type ColumnDef,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type RowData,
  type SortingState,
  type Updater,
  type VisibilityState,
} from '@tanstack/solid-table';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { css, cx } from '../styled-system/css';
import {
  clampNumber,
  type DateBounds,
  dateFromIndex,
  dateRangePresets,
  normalizeDateIndexRange,
  rowMatchesDateBounds,
  rowTime,
  shiftCalendarDays,
  startOfDay,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';
import { createDateRangeController, type DateRangeController } from './date-range-controller';
import {
  type DashboardSearch,
  dashboardSearchDefaultsFor,
  type FieldFilterKey,
  type FieldFilters,
  isDashboardTab,
  isSessionColumnId,
  type SearchableColumnDiffId,
  type SessionColumnId,
  sortingStateFromSearch,
} from './dashboard-search';
import { isDemoReportPayload, readReportPayload } from './report-data';

declare module '@tanstack/solid-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    cellClass?: string;
    defaultVisible?: boolean;
    headerClass?: string;
    label: string;
    title?: string;
    widthPx: number;
  }

  interface TableMeta<TData extends RowData> {
    onFieldFilter?: (key: FieldFilterKey, value: string) => void;
    onHarnessFilter?: (value: string) => void;
  }
}

const payload = readReportPayload();

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

const fmtNum = (n: number) => numberFormatter.format(n);
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
const fmtDate = (value: string | null) => (value ? dateTimeFormatter.format(new Date(value)) : '—');
const fmtDateOnly = (value: string | Date | null) =>
  value ? dateOnlyFormatter.format(value instanceof Date ? value : new Date(value)) : '—';

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

type DashboardRow = SerializedRow & {
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

const enrichReportRow = (row: SerializedRow): DashboardRow => {
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

const reportRows = payload.rows.map(enrichReportRow);

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

const timeRangePanel = css({
  display: 'grid',
  gap: '14px',
  mt: '14px',
  p: '14px 16px 16px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const timeRangeHeader = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  gap: '12px',
  alignItems: 'start',
});

const timeRangeTitle = css({
  fontSize: '14px',
  fontWeight: 650,
});

const timeRangeMeta = css({
  color: 'muted',
  fontSize: '12px',
  mt: '2px',
});

const presetGroup = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  justifyContent: { base: 'flex-start', md: 'flex-end' },
  minW: 0,
  m: 0,
  p: 0,
  border: 0,
});

const presetButton = css({
  appearance: 'none',
  h: '30px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'border-color 0.15s, color 0.15s, background-color 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  '&[data-active="true"]': {
    bg: 'accentSoft',
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const dateEditRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'end',
});

const dateFieldGroup = css({
  display: 'grid',
  gap: '4px',
});

const inlineFieldLabel = css({
  textStyle: 'label',
  color: 'muted',
});

const timeSliderRoot = css({
  display: 'grid',
  gap: '8px',
});

const timeSliderControl = css({
  position: 'relative',
  h: '128px',
});

const timeSliderTrack = css({
  position: 'relative',
  h: '128px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  overflow: 'hidden',
  cursor: 'ew-resize',
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.32)',
  _focusWithin: {
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
});

const timeSliderBars = css({
  position: 'absolute',
  inset: '8px 8px 22px',
  display: 'flex',
  alignItems: 'flex-end',
  gap: '2px',
  pointerEvents: 'none',
  zIndex: 2,
});

const timeBucket = css({
  flex: '1 1 0',
  minW: '2px',
  h: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: '1px',
});

const timeBucketSegment = css({
  w: '100%',
  minH: '1px',
  borderRadius: '1px',
});

const timeSliderRange = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 1,
  bg: 'focusRing',
  borderLeft: '2px solid token(colors.accent)',
  borderRight: '2px solid token(colors.accent)',
  pointerEvents: 'none',
});

const timeSliderRangeDrag = css({
  appearance: 'none',
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 'var(--slider-range-start)',
  right: 'var(--slider-range-end)',
  zIndex: 3,
  border: '0',
  p: 0,
  bg: 'transparent',
  cursor: 'grab',
  touchAction: 'none',
  _hover: {
    bg: 'rgba(177, 78, 18, 0.08)',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
    bg: 'rgba(177, 78, 18, 0.12)',
  },
  _before: {
    content: '""',
    position: 'absolute',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    w: '46px',
    h: '22px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: 'card',
    opacity: 0.9,
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '21px',
    left: '50%',
    transform: 'translateX(-50%)',
    w: '20px',
    h: '4px',
    borderTop: '1px solid token(colors.accent)',
    borderBottom: '1px solid token(colors.accent)',
  },
});

const timeSliderThumb = css({
  top: '32px',
  zIndex: 4,
  w: '32px',
  h: '64px',
  border: '0',
  borderRadius: 'full',
  bg: 'transparent',
  cursor: 'ew-resize',
  _before: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '18px',
    h: '52px',
    border: '2px solid token(colors.accent)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: 'overlay',
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '5px',
    h: '28px',
    borderLeft: '1px solid token(colors.accent)',
    borderRight: '1px solid token(colors.accent)',
    opacity: 0.75,
  },
  _hover: {
    _before: {
      boxShadow: '0 0 0 4px token(colors.focusRing), token(shadows.overlay)',
    },
  },
  _focusVisible: {
    outline: '2px solid token(colors.ink)',
    outlineOffset: '-2px',
  },
});

const timeAxis = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'faint',
  fontSize: '11px',
  fontFamily: 'mono',
});

const activeFilters = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

const activeFilterButton = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  h: '24px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '11px',
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

const tableControls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'space-between',
});

const tableControlMeta = css({
  color: 'muted',
  fontSize: '12px',
});

const columnChooser = css({
  display: 'flex',
  flex: '1 1 520px',
  flexWrap: 'wrap',
  gap: '6px',
  alignItems: 'center',
  justifyContent: { base: 'flex-start', md: 'flex-end' },
  minW: 0,
  p: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
});

const columnChooserHeader = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  pr: '4px',
});

const columnToggle = css({
  display: 'inline-grid',
  gridTemplateColumns: '14px minmax(0, max-content)',
  gap: '6px',
  alignItems: 'center',
  maxW: '180px',
  minH: '28px',
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'canvas',
  color: 'ink',
  fontSize: '12px',
  cursor: 'pointer',
  transition: 'border-color 0.15s, background-color 0.15s',
  _hover: {
    bg: 'surfaceMuted',
    borderColor: 'lineStrong',
  },
});

const columnToggleInput = css({
  accentColor: 'token(colors.accent)',
});

const columnToggleText = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
const filterTextButton = css({
  appearance: 'none',
  display: 'inline',
  maxW: '100%',
  border: '0',
  p: '0',
  bg: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  overflowWrap: 'anywhere',
  cursor: 'pointer',
  _hover: {
    color: 'accent',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});
const groupKeyButton = cx(filterTextButton, css({ fontWeight: 600 }));
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

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
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
type ReportSummary = {
  actualCost: number;
  fresh: number;
  meanCost: number;
  rtkInput: number;
  rtkOutput: number;
  rtkSaved: number;
  sessionCount: number;
  tools: number;
  totalCost: number;
  turns: number;
  unknownActual: number;
};
type MutableAnalyticsGroup = AnalyticsGroup & { costs: number[] };

const applyTableUpdate = <T,>(updater: Updater<T>, current: T) =>
  typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;

const MetricTile = (props: Metric) => (
  <div class={metricTile} title={props.hint}>
    <div class={metricLabel}>{props.label}</div>
    <div class={metricValue}>{props.value}</div>
  </div>
);

const HarnessBadge = (props: { name: string; onClick?: () => void }) => {
  const className = () => cx(badge, badgeToneFor(props.name), props.onClick ? badgeButton : undefined);
  if (!props.onClick) return <span class={className()}>{props.name}</span>;
  return (
    <button
      class={className()}
      type="button"
      title={`Filter by ${props.name}`}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.();
      }}
    >
      {props.name}
    </button>
  );
};

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

const rowKey = (row: DashboardRow) => row.rowId;

const fieldValueForRow = (row: DashboardRow, key: FieldFilterKey) => {
  if (key === 'provider') return row.providerDisplay;
  if (key === 'model') return row.modelKey;
  return row.projectKey;
};

type FilterSnapshot = {
  fieldEntries: [FieldFilterKey, string][];
  harness: string;
  query: string;
};

const createFilterSnapshot = (query: string, harness: string, filters: FieldFilters): FilterSnapshot => ({
  fieldEntries: Object.entries(filters) as [FieldFilterKey, string][],
  harness,
  query: query.trim().toLowerCase(),
});

const matchesFilterSnapshot = (row: DashboardRow, filters: FilterSnapshot) =>
  row.searchText.includes(filters.query) &&
  (filters.harness === 'all' || row.harness === filters.harness) &&
  filters.fieldEntries.every(([key, value]) => fieldValueForRow(row, key) === value);

const matchesFilterSnapshotAndDate = (row: DashboardRow, filters: FilterSnapshot, bounds: DateBounds) =>
  matchesFilterSnapshot(row, filters) && rowMatchesDateBounds(row, bounds);

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
    'rtk_saved_tokens',
    'rtk_input_tokens',
    'rtk_output_tokens',
    'rtk_savings_pct',
    'rtk_command_count',
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
      row.rtkSavedTokens ?? '',
      row.rtkInputTokens ?? '',
      row.rtkOutputTokens ?? '',
      rtkSavingsPct(row)?.toFixed(2) ?? '',
      row.rtkCommandCount ?? '',
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

const sortValueForRow = (row: DashboardRow, columnId: string): number | string => {
  if (columnId === 'date') return row.sortDate;
  if (columnId === 'harness') return row.sortHarness;
  if (columnId === 'provider') return row.sortProvider;
  if (columnId === 'model') return row.sortModel;
  if (columnId === 'project') return row.sortProject;
  if (columnId === 'tokIn') return row.tokIn;
  if (columnId === 'tokOut') return row.tokOut;
  if (columnId === 'cache') return row.tokCr;
  if (columnId === 'tokCw') return row.tokCw;
  if (columnId === 'fresh') return row.freshTokens;
  if (columnId === 'total') return row.tokenTotal;
  if (columnId === 'cost') return row.costKnown ? row.costApprox : Number.NEGATIVE_INFINITY;
  if (columnId === 'actual') return row.costActual ?? Number.NEGATIVE_INFINITY;
  if (columnId === 'duration') return row.durationMs ?? 0;
  if (columnId === 'calls') return row.calls;
  if (columnId === 'turns') return row.turns;
  if (columnId === 'tools') return row.tools;
  if (columnId === 'lines') return row.lineDelta ?? 0;
  if (columnId === 'rtkSaved') return rtkSavingsPct(row) ?? 0;
  if (columnId === 'subagent') return row.subagent ? 1 : 0;
  if (columnId === 'partial') return row.partial ? 1 : 0;
  return row.sortSession;
};

const compareRows = (sorting: SortingState) => (a: DashboardRow, b: DashboardRow) => {
  for (const sort of sorting) {
    const av = sortValueForRow(a, sort.id);
    const bv = sortValueForRow(b, sort.id);
    const result =
      typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv))
        : av === bv
          ? 0
          : av > bv
            ? 1
            : -1;
    if (result !== 0) return sort.desc ? -result : result;
  }
  return 0;
};

const lineDeltaLabel = (row: SerializedRow) => {
  if (row.lineDelta == null || row.lineDelta === 0) return '-';
  return `+${fmtMaybeNum(row.linesAdded)}/-${fmtMaybeNum(row.linesDeleted)}`;
};

const rtkSavingsPct = (row: SerializedRow) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;

const rtkSavedLabel = (row: SerializedRow) => {
  const pct = rtkSavingsPct(row);
  return pct == null ? '—' : fmtPct(pct);
};
const rtkSavedTitle = (row: SerializedRow) =>
  row.rtkSavedTokens
    ? [
        `${fmtPct(rtkSavingsPct(row) ?? 0)} RTK savings`,
        `${fmtNum(row.rtkSavedTokens)} tokens saved`,
        `${fmtNum(row.rtkCommandCount ?? 0)} matched RTK commands`,
        `${fmtNum(row.rtkInputTokens ?? 0)} input tokens before filtering`,
        `${fmtNum(row.rtkOutputTokens ?? 0)} output tokens after filtering`,
        'Matched by project path and session time window',
      ].join('\n')
    : 'No matched RTK token savings';

type SessionColumnDef = ColumnDef<DashboardRow> & { id: SessionColumnId };

const sessionColumns: SessionColumnDef[] = [
  {
    id: 'date',
    header: 'Date',
    accessorFn: (row) => sortValueForRow(row, 'date'),
    cell: (info) => fmtDate(info.row.original.activeDate),
    sortDescFirst: true,
    meta: { label: 'Date', widthPx: 104, cellClass: dateCell },
  },
  {
    id: 'harness',
    header: 'Harness',
    accessorFn: (row) => sortValueForRow(row, 'harness'),
    cell: (info) => (
      <HarnessBadge
        name={info.row.original.harness}
        onClick={() => info.table.options.meta?.onHarnessFilter?.(info.row.original.harness)}
      />
    ),
    meta: { label: 'Harness', widthPx: 100 },
  },
  {
    id: 'provider',
    header: 'Provider',
    accessorFn: (row) => sortValueForRow(row, 'provider'),
    cell: (info) => {
      const row = info.row.original;
      const label = row.providerDisplay;
      return (
        <button
          class={filterTextButton}
          type="button"
          title={`Filter by ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('provider', label);
          }}
        >
          {label}
        </button>
      );
    },
    meta: { label: 'Provider', widthPx: 124 },
  },
  {
    id: 'model',
    header: 'Model',
    accessorFn: (row) => sortValueForRow(row, 'model'),
    cell: (info) => {
      const row = info.row.original;
      return (
        <button
          class={filterTextButton}
          type="button"
          title={`Filter by ${row.modelKey}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('model', row.modelKey);
          }}
        >
          {row.model}
        </button>
      );
    },
    meta: { label: 'Model', widthPx: 168, cellClass: modelCell },
  },
  {
    id: 'project',
    header: 'Project',
    accessorFn: (row) => sortValueForRow(row, 'project'),
    cell: (info) => {
      const row = info.row.original;
      const label = row.projectKey;
      return (
        <button
          class={filterTextButton}
          type="button"
          title={`Filter by ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            info.table.options.meta?.onFieldFilter?.('project', label);
          }}
        >
          {row.project || '—'}
        </button>
      );
    },
    meta: { label: 'Project', widthPx: 120 },
  },
  {
    id: 'tokIn',
    header: 'Input',
    accessorFn: (row) => row.tokIn,
    cell: (info) => fmtCompact(info.row.original.tokIn),
    sortDescFirst: true,
    meta: { label: 'Input tokens', widthPx: 90, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'tokOut',
    header: 'Output',
    accessorFn: (row) => row.tokOut,
    cell: (info) => fmtCompact(info.row.original.tokOut),
    sortDescFirst: true,
    meta: { label: 'Output tokens', widthPx: 94, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'cache',
    header: 'Cache',
    accessorFn: (row) => row.tokCr,
    cell: (info) => fmtCompact(info.row.original.tokCr),
    sortDescFirst: true,
    meta: {
      label: 'Cache read',
      title: 'Cache-read tokens',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'tokCw',
    header: 'Write',
    accessorFn: (row) => row.tokCw,
    cell: (info) => fmtCompact(info.row.original.tokCw),
    sortDescFirst: true,
    meta: {
      label: 'Cache write',
      title: 'Cache-write tokens',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
      defaultVisible: false,
    },
  },
  {
    id: 'fresh',
    header: 'Fresh',
    accessorFn: (row) => row.freshTokens,
    cell: (info) => fmtCompact(info.row.original.freshTokens),
    sortDescFirst: true,
    meta: {
      label: 'Fresh tokens',
      title: 'Tokens processed without cache (input + output + cache writes)',
      widthPx: 84,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'total',
    header: 'Total',
    accessorFn: (row) => row.tokenTotal,
    cell: (info) => fmtCompact(info.row.original.tokenTotal),
    sortDescFirst: true,
    meta: { label: 'Total tokens', widthPx: 90, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'rtkSaved',
    header: 'RTK',
    accessorFn: (row) => rtkSavingsPct(row) ?? 0,
    cell: (info) => <span title={rtkSavedTitle(info.row.original)}>{rtkSavedLabel(info.row.original)}</span>,
    sortDescFirst: true,
    meta: {
      label: 'RTK savings',
      title: 'RTK saved-token percentage; hover a cell for matched command details',
      widthPx: 86,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'cost',
    header: '$API',
    accessorFn: (row) => sortValueForRow(row, 'cost'),
    cell: (info) => (
      <Show when={info.row.original.costKnown} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
        {fmtMoney(info.row.original.costApprox)}
      </Show>
    ),
    sortDescFirst: true,
    meta: {
      label: 'API value',
      title: 'Estimated cost at standard API prices',
      widthPx: 76,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'actual',
    header: '$Actual',
    accessorFn: (row) => sortValueForRow(row, 'actual'),
    cell: (info) => fmtMoney(info.row.original.costActual),
    sortDescFirst: true,
    meta: {
      label: 'Actual cost',
      title: 'Out-of-pocket spend reported by harnesses',
      widthPx: 88,
      cellClass: numCell,
      headerClass: right,
      defaultVisible: false,
    },
  },
  {
    id: 'duration',
    header: 'Span',
    accessorFn: (row) => row.durationMs ?? 0,
    cell: (info) => fmtDuration(info.row.original.durationMs),
    sortDescFirst: true,
    meta: {
      label: 'Duration',
      title: 'Wall-clock session duration',
      widthPx: 68,
      cellClass: numCell,
      headerClass: right,
    },
  },
  {
    id: 'calls',
    header: 'Calls',
    accessorFn: (row) => row.calls,
    cell: (info) => fmtNum(info.row.original.calls),
    sortDescFirst: true,
    meta: { label: 'Calls', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'turns',
    header: 'Turns',
    accessorFn: (row) => row.turns,
    cell: (info) => fmtNum(info.row.original.turns),
    sortDescFirst: true,
    meta: { label: 'Turns', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'tools',
    header: 'Tools',
    accessorFn: (row) => row.tools,
    cell: (info) => fmtNum(info.row.original.tools),
    sortDescFirst: true,
    meta: { label: 'Tools', widthPx: 76, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'lines',
    header: 'Lines',
    accessorFn: (row) => row.lineDelta ?? 0,
    cell: (info) => lineDeltaLabel(info.row.original),
    sortDescFirst: true,
    meta: { label: 'Lines changed', widthPx: 96, cellClass: numCell, headerClass: right, defaultVisible: false },
  },
  {
    id: 'subagent',
    header: 'Sub',
    accessorFn: (row) => (row.subagent ? 1 : 0),
    cell: (info) => (info.row.original.subagent ? 'Yes' : 'No'),
    sortDescFirst: true,
    meta: { label: 'Subagent', widthPx: 72, defaultVisible: false },
  },
  {
    id: 'partial',
    header: 'Partial',
    accessorFn: (row) => (row.partial ? 1 : 0),
    cell: (info) => (info.row.original.partial ? 'Yes' : 'No'),
    sortDescFirst: true,
    meta: { label: 'Partial', widthPx: 82, defaultVisible: false },
  },
  {
    id: 'session',
    header: 'Session',
    accessorFn: (row) => row.sessionLabel.toLowerCase(),
    cell: (info) => <div class={sessionTitleClamp}>{info.row.original.sessionLabel}</div>,
    enableHiding: false,
    meta: { label: 'Session', widthPx: 300, cellClass: sessionCell },
  },
];

const defaultColumnVisibility = Object.fromEntries(
  sessionColumns.filter((column) => column.meta?.defaultVisible === false).map((column) => [column.id, false]),
) as VisibilityState;
const dashboardSearchDefaults = dashboardSearchDefaultsFor(payload.filters.sort);

const isSessionColumnVisible = (visibility: VisibilityState, columnId: string) => visibility[columnId] !== false;

const visibleSessionColumns = (visibility: VisibilityState) =>
  sessionColumns.filter((column) => isSessionColumnVisible(visibility, column.id));

const columnVisibilityFromDiff = (columnDiff: SearchableColumnDiffId[]): VisibilityState => {
  const visibility = { ...defaultColumnVisibility };
  for (const columnId of columnDiff) {
    visibility[columnId] = defaultColumnVisibility[columnId] === false;
  }
  return visibility;
};

const columnDiffFromVisibility = (visibility: VisibilityState): SearchableColumnDiffId[] =>
  sessionColumns.flatMap((column) => {
    if (column.enableHiding === false) return [];
    const defaultVisible = isSessionColumnVisible(defaultColumnVisibility, column.id);
    const currentVisible = isSessionColumnVisible(visibility, column.id);
    return defaultVisible === currentVisible ? [] : [column.id as SearchableColumnDiffId];
  });

const sortFromSortingState = (sorting: SortingState) => {
  const sort = sorting[0];
  if (!sort || !isSessionColumnId(sort.id)) return dashboardSearchDefaults.sort;
  return { id: sort.id, desc: sort.desc };
};

const sessionColumnLabel = (column: SessionColumnDef) => column.meta?.label ?? column.id;

const sessionColumnHeader = (column: SessionColumnDef) =>
  typeof column.header === 'string' ? column.header : sessionColumnLabel(column);

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const createAnalyticsGroup = (key: string, row: DashboardRow): MutableAnalyticsGroup => ({
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
});

const addAnalyticsRow = (groups: Map<string, MutableAnalyticsGroup>, key: string, row: DashboardRow) => {
  let group = groups.get(key);
  if (!group) {
    group = createAnalyticsGroup(key, row);
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
};

const finalizeAnalyticsGroups = (groups: Map<string, MutableAnalyticsGroup>, totalCost: number): AnalyticsGroup[] =>
  [...groups.values()]
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

const createProjectGroup = (key: string): ProjectGroup => ({
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
});

const addProjectRow = (groups: Map<string, ProjectGroup>, row: DashboardRow) => {
  let group = groups.get(row.projectKey);
  if (!group) {
    group = createProjectGroup(row.projectKey);
    groups.set(row.projectKey, group);
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
};

const createReportSummary = (): ReportSummary => ({
  actualCost: 0,
  fresh: 0,
  meanCost: 0,
  rtkInput: 0,
  rtkOutput: 0,
  rtkSaved: 0,
  sessionCount: 0,
  tools: 0,
  totalCost: 0,
  turns: 0,
  unknownActual: 0,
});

const buildReportSummary = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
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
    summary.rtkSaved += row.rtkSavedTokens ?? 0;
    summary.rtkInput += row.rtkInputTokens ?? 0;
    summary.rtkOutput += row.rtkOutputTokens ?? 0;
    summary.turns += row.turns;
    summary.tools += row.tools;
  }

  summary.meanCost = summary.totalCost / (pricedCount || 1);
  return summary;
};

const buildAnalyticsGroups = (
  rows: DashboardRow[],
  acceptsRow: (row: DashboardRow) => boolean,
  keyForRow: (row: DashboardRow) => string,
  totalCost: number,
) => {
  const groups = new Map<string, MutableAnalyticsGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addAnalyticsRow(groups, keyForRow(row), row);
  }

  return finalizeAnalyticsGroups(groups, totalCost);
};

const buildProjectGroups = (rows: DashboardRow[], acceptsRow: (row: DashboardRow) => boolean) => {
  const projects = new Map<string, ProjectGroup>();

  for (const row of rows) {
    if (!acceptsRow(row)) continue;
    addProjectRow(projects, row);
  }

  return [...projects.values()].sort((a, b) => b.cost - a.cost || b.fresh - a.fresh);
};

const SortHeader = (props: { column: Column<DashboardRow, unknown>; label: string }) => {
  const meta = () => props.column.columnDef.meta;
  const sortDirection = () => props.column.getIsSorted();

  return (
    <Show when={props.column.getCanSort()} fallback={<span class={meta()?.headerClass}>{props.label}</span>}>
      <button
        class={cx(sortButton, meta()?.headerClass)}
        type="button"
        title={meta()?.title}
        onClick={(event) => props.column.getToggleSortingHandler()?.(event)}
      >
        <span>{props.label}</span>
        <Show when={sortDirection()}>
          {(direction) => (
            <span class={sortArrow} aria-hidden="true">
              {direction() === 'asc' ? '↑' : '↓'}
            </span>
          )}
        </Show>
      </button>
    </Show>
  );
};

const ColumnVisibilityControl = (props: {
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
}) => {
  const hideableColumns = () => sessionColumns.filter((column) => column.enableHiding !== false);
  const visibleCount = () => visibleSessionColumns(props.columnVisibility).length;
  const setColumnVisible = (id: string, visible: boolean) =>
    props.onColumnVisibilityChange((current) => ({ ...current, [id]: visible }));

  return (
    <div class={columnChooser}>
      <div class={columnChooserHeader}>
        <span class={muted}>{visibleCount()} columns</span>
        <button
          class={ghostButton}
          type="button"
          onClick={() => props.onColumnVisibilityChange(defaultColumnVisibility)}
        >
          Reset
        </button>
      </div>
      <For each={hideableColumns()}>
        {(column) => (
          <label class={columnToggle}>
            <input
              class={columnToggleInput}
              type="checkbox"
              checked={isSessionColumnVisible(props.columnVisibility, column.id)}
              onChange={(event) => setColumnVisible(column.id, event.currentTarget.checked)}
            />
            <span class={columnToggleText}>{sessionColumnLabel(column)}</span>
          </label>
        )}
      </For>
    </div>
  );
};

const DetailItem = (props: { label: string; value: string; hint?: string }) => (
  <div class={detailItem} title={props.hint}>
    <div class={detailLabel}>{props.label}</div>
    <div class={detailValue}>{props.value}</div>
  </div>
);

const SessionDrawer = (props: { row: DashboardRow; onClose: () => void }) => (
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
          {props.row.providerDisplay} · {props.row.model}
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
        <DetailItem label="RTK savings" value={rtkSavedLabel(props.row)} hint={rtkSavedTitle(props.row)} />
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
  rows: DashboardRow[];
  selectedKey: string | null;
  sorting: SortingState;
  columnVisibility: VisibilityState;
  onSortingChange: OnChangeFn<SortingState>;
  onColumnVisibilityChange: OnChangeFn<VisibilityState>;
  onSelect: (row: DashboardRow) => void;
  onHarnessFilter: (value: string) => void;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onClearFilters: () => void;
}) => {
  const sessionTable = createSolidTable<DashboardRow>({
    get data() {
      return props.rows;
    },
    columns: sessionColumns,
    get state() {
      return {
        sorting: props.sorting,
        columnVisibility: props.columnVisibility,
      };
    },
    enableMultiSort: false,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => rowKey(row),
    getSortedRowModel: getSortedRowModel(),
    meta: {
      onFieldFilter: props.onFieldFilter,
      onHarnessFilter: props.onHarnessFilter,
    },
    onColumnVisibilityChange: props.onColumnVisibilityChange,
    onSortingChange: props.onSortingChange,
  });
  const visibleColumns = createMemo(() =>
    visibleSessionColumns(props.columnVisibility)
      .map((columnDef) => ({ columnDef, tableColumn: sessionTable.getColumn(columnDef.id) }))
      .filter((column): column is { columnDef: SessionColumnDef; tableColumn: Column<DashboardRow, unknown> } =>
        Boolean(column.tableColumn),
      ),
  );
  const visibleColumnIds = createMemo<Set<string>>(() => new Set(visibleColumns().map(({ columnDef }) => columnDef.id)));
  const tableMinWidth = () =>
    Math.max(
      1040,
      visibleColumns().reduce((sum, { columnDef }) => sum + (columnDef.meta?.widthPx ?? 140), 0),
    );
  let tableViewportEl: HTMLDivElement | undefined;
  const rowHeight = 43;
  const overscanRows = 8;
  const [tableViewport, setTableViewport] = createSignal({ height: 520, scrollTop: 0 });
  const updateTableViewport = () => {
    const next = {
      height: tableViewportEl?.clientHeight ?? 520,
      scrollTop: tableViewportEl?.scrollTop ?? 0,
    };
    setTableViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  };
  const rowModelRows = createMemo(() => {
    props.rows;
    props.sorting;
    return sessionTable.getRowModel().rows;
  });
  const visibleColumnCount = () => visibleColumns().length;
  const virtualRows = createMemo(() => {
    const rows = rowModelRows();
    const viewport = tableViewport();
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscanRows);
    const end = Math.min(rows.length, start + Math.ceil(viewport.height / rowHeight) + overscanRows * 2);
    return {
      bottomHeight: Math.max(0, rows.length - end) * rowHeight,
      rows: rows.slice(start, end),
      topHeight: start * rowHeight,
    };
  });

  onMount(() => {
    updateTableViewport();
    const observer = new ResizeObserver(updateTableViewport);
    if (tableViewportEl) observer.observe(tableViewportEl);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    props.rows;
    props.sorting;
    if (tableViewportEl) tableViewportEl.scrollTop = 0;
    updateTableViewport();
  });

  return (
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
      <div class={tableControls}>
        <div class={tableControlMeta}>
          {fmtNum(rowModelRows().length)} rows · {visibleColumns().length} columns
        </div>
        <ColumnVisibilityControl
          columnVisibility={props.columnVisibility}
          onColumnVisibilityChange={props.onColumnVisibilityChange}
        />
      </div>
      <div class={tableWrap} ref={tableViewportEl} onScroll={updateTableViewport}>
        <table class={cx(table, sessionsTable)} style={{ 'min-width': `${tableMinWidth()}px` }}>
          <thead>
            <tr>
              <For each={visibleColumns()}>
                {({ columnDef, tableColumn }) => (
                  <th
                    class={columnDef.meta?.headerClass}
                    title={columnDef.meta?.title}
                    style={{ width: `${columnDef.meta?.widthPx ?? 140}px` }}
                  >
                    <SortHeader column={tableColumn} label={sessionColumnHeader(columnDef)} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show when={virtualRows().topHeight > 0}>
              <tr>
                <td
                  colSpan={visibleColumnCount()}
                  style={{ height: `${virtualRows().topHeight}px`, padding: '0', border: '0' }}
                />
              </tr>
            </Show>
            <For each={virtualRows().rows}>
              {(tableRow) => (
                <tr
                  data-selected={String(props.selectedKey === tableRow.id)}
                  tabIndex={0}
                  onClick={() => props.onSelect(tableRow.original)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    props.onSelect(tableRow.original);
                  }}
                >
                  <For each={tableRow.getAllCells().filter((cell) => visibleColumnIds().has(cell.column.id))}>
                    {(cell) => (
                      <td class={cell.column.columnDef.meta?.cellClass}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <Show when={virtualRows().bottomHeight > 0}>
              <tr>
                <td
                  colSpan={visibleColumnCount()}
                  style={{ height: `${virtualRows().bottomHeight}px`, padding: '0', border: '0' }}
                />
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
    </Show>
  );
};

const GroupPanel = (props: {
  title: string;
  groups: AnalyticsGroup[];
  countLabel: string;
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
}) => {
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
                <Show when={props.onFilter} fallback={<div class={strongCell}>{group.key}</div>}>
                  <button class={groupKeyButton} type="button" onClick={() => props.onFilter?.(group.key)}>
                    {group.key}
                  </button>
                </Show>
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

type TimelinePart = { harness: string; cost: number };
type TimelineBucket = { date: Date; endDate: Date; total: number; sessions: number; parts: TimelinePart[] };

const timelineBucketTitle = (bucket: TimelineBucket, weekly: boolean, valueMode: 'cost' | 'sessions') =>
  [
    `${weekly ? 'Week of ' : ''}${fmtDateOnly(bucket.date)} — ${
      valueMode === 'cost' ? fmtMoney(bucket.total) : `${fmtNum(bucket.sessions)} sessions`
    }`,
    ...bucket.parts.map((part) => `${part.harness} ${fmtMoney(part.cost)}`),
  ].join('\n');

const TimeRangeControl = (props: {
  rows: DashboardRow[];
  dateRange: DateRangeController;
  onDateRangeCommit: () => void;
}) => {
  const [chartDomain, setChartDomain] = createSignal(props.dateRange.domain());
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());
  createEffect(() => {
    props.rows;
    setChartDomain(untrack(() => props.dateRange.domain()));
  });

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) return null;
    const dated = props.rows
      .map((row) => ({ row, time: rowTime(row) }))
      .filter((item): item is { row: DashboardRow; time: number } => item.time != null);
    const dayCount = domain.maxIndex + 1;
    // Weekly buckets past ~4 months keep the bars readable (and the DOM small).
    const weekly = dayCount > 120;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const buckets = new Map<string, TimelineBucket & { byHarness: Map<string, number> }>();
    for (
      let cursor = bucketStart(domain.minDay);
      cursor <= domain.maxDay;
      cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)
    ) {
      buckets.set(toDateInputValue(cursor), {
        date: cursor,
        endDate: weekly ? shiftCalendarDays(cursor, 6) : cursor,
        total: 0,
        sessions: 0,
        parts: [],
        byHarness: new Map(),
      });
    }
    const harnessTotals = new Map<string, number>();
    for (const { row, time } of dated) {
      const bucket = buckets.get(toDateInputValue(bucketStart(new Date(time))));
      if (!bucket) continue;
      bucket.sessions++;
      if (row.costKnown) {
        bucket.total += row.costApprox;
        bucket.byHarness.set(row.harness, (bucket.byHarness.get(row.harness) ?? 0) + row.costApprox);
        harnessTotals.set(row.harness, (harnessTotals.get(row.harness) ?? 0) + row.costApprox);
      }
    }
    const harnesses = [...harnessTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const list = [...buckets.values()].map((bucket) => ({
      date: bucket.date,
      endDate: bucket.endDate > domain.maxDay ? domain.maxDay : bucket.endDate,
      total: bucket.total,
      sessions: bucket.sessions,
      parts: harnesses
        .map((name) => ({ harness: name, cost: bucket.byHarness.get(name) ?? 0 }))
        .filter((part) => part.cost > 0),
    }));
    const maxTotal = Math.max(...list.map((bucket) => bucket.total));
    const maxSessions = Math.max(...list.map((bucket) => bucket.sessions));
    const valueMode: 'cost' | 'sessions' = maxTotal > 0 ? 'cost' : 'sessions';
    const maxValue = valueMode === 'cost' ? maxTotal : maxSessions;
    if (maxValue <= 0) return null;
    return {
      list,
      maxValue,
      valueMode,
      weekly,
      harnesses,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  const [draggingSelection, setDraggingSelection] = createSignal(false);
  let selectionDrag: {
    pointerId: number;
    startX: number;
    startFrom: number;
    startTo: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;

  const indexesForValue = (value: number[]): [number, number] | null => {
    const chart = data();
    if (!chart) return null;
    return normalizeDateIndexRange(value, chart.maxIndex);
  };

  const previewSliderValue = (value: number[]) => {
    const nextIndexes = indexesForValue(value);
    if (!nextIndexes) return;
    props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
  };

  const commitIndexes = (value?: number[]) => {
    if (value) {
      const nextIndexes = indexesForValue(value);
      if (nextIndexes) props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
    }
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyPreset = (mode: TimeRangePreset) => {
    props.dateRange.setPreset(mode);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyFromInput = (from: string) => {
    props.dateRange.setFromInput(from);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyToInput = (to: string) => {
    props.dateRange.setToInput(to);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const startSelectionDrag = (event: RangeDragPointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (event.button !== 0) return;
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) return;
    const [startFrom, startTo] = props.dateRange.selectedIndexes();
    selectionDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startFrom,
      startTo,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    setDraggingSelection(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    const span = selectionDrag.startTo - selectionDrag.startFrom;
    const delta = Math.round(
      ((event.clientX - selectionDrag.startX) / selectionDrag.trackWidth) * selectionDrag.maxIndex,
    );
    const from = clampNumber(selectionDrag.startFrom + delta, 0, Math.max(0, selectionDrag.maxIndex - span));
    props.dateRange.setIndexes(from, from + span);
    event.preventDefault();
    event.stopPropagation();
  };

  const endSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
    selectionDrag = null;
    commitIndexes();
    setDraggingSelection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Show
      when={data()}
      fallback={
        <section class={timeRangePanel} aria-label="Date range">
          <div>
            <div class={timeRangeTitle}>Time range</div>
            <div class={timeRangeMeta}>No dated sessions match the current filters</div>
          </div>
        </section>
      }
    >
      {(chart) => (
        <section class={timeRangePanel} aria-label="Date range">
          <div class={timeRangeHeader}>
            <div>
              <div class={timeRangeTitle}>Time range</div>
              <div class={timeRangeMeta}>{props.dateRange.label()}</div>
            </div>
            <fieldset class={presetGroup} aria-label="Date presets">
              <For each={dateRangePresets}>
                {(preset) => (
                  <button
                    class={presetButton}
                    type="button"
                    data-active={String(props.dateRange.mode() === preset.mode)}
                    onClick={() => applyPreset(preset.mode)}
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </fieldset>
          </div>

          <div class={dateEditRow}>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>From</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().from}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyFromInput(event.currentTarget.value)}
              />
            </label>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>To</span>
              <input
                class={dateInput}
                type="date"
                value={props.dateRange.inputValues().to}
                min={toDateInputValue(chart().minDay)}
                max={toDateInputValue(chart().maxDay)}
                onInput={(event) => applyToInput(event.currentTarget.value)}
              />
            </label>
            <div class={chartLegend}>
              <For each={chart().harnesses}>{(name) => <HarnessBadge name={name} />}</For>
            </div>
          </div>

          <Slider.Root
            class={timeSliderRoot}
            min={0}
            max={chart().maxIndex}
            step={1}
            value={props.dateRange.selectedIndexes()}
            thumbSize={{ width: 32, height: 64 }}
            aria-label={['Start date', 'End date']}
            getAriaValueText={(details) => fmtDateOnly(dateFromIndex(chart().minDay, details.value))}
            onValueChange={(details) => previewSliderValue(details.value)}
            onValueChangeEnd={(details) => commitIndexes(details.value)}
          >
            <Slider.Control class={timeSliderControl}>
              <Slider.Track class={timeSliderTrack}>
                <Slider.Range class={timeSliderRange} />
                <div class={timeSliderBars} aria-hidden="true">
                  <For each={chart().list}>
                    {(bucket) => (
                      <div class={timeBucket} title={timelineBucketTitle(bucket, chart().weekly, chart().valueMode)}>
                        <Show
                          when={chart().valueMode === 'cost'}
                          fallback={
                            <div
                              class={cx(timeBucketSegment, accentFill)}
                              style={{ height: `${Math.max(2, (bucket.sessions / chart().maxValue) * 100)}%` }}
                            />
                          }
                        >
                          <For each={bucket.parts}>
                            {(part) => (
                              <div
                                class={cx(timeBucketSegment, harnessFillFor(part.harness) ?? accentFill)}
                                style={{ height: `${Math.max(2, (part.cost / chart().maxValue) * 100)}%` }}
                              />
                            )}
                          </For>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <button
                  class={timeSliderRangeDrag}
                  type="button"
                  tabIndex={-1}
                  aria-label="Drag selected date range"
                  title="Drag selected range"
                  data-dragging={String(draggingSelection())}
                  onPointerDown={(event) => startSelectionDrag(event, chart())}
                  onPointerMove={moveSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  onLostPointerCapture={endSelectionDrag}
                />
              </Slider.Track>
              <Slider.Thumb index={0} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
              <Slider.Thumb index={1} class={timeSliderThumb}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
            <div class={timeAxis}>
              <span>{fmtDateOnly(chart().minDay)}</span>
              <span>{fmtDateOnly(chart().maxDay)}</span>
            </div>
          </Slider.Root>
        </section>
      )}
    </Show>
  );
};

const ProjectSummary = (props: { groups: ProjectGroup[]; onProjectFilter: (value: string) => void }) => (
  <Show when={props.groups.length} fallback={<div class={empty}>No projects</div>}>
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
          <For each={props.groups}>
            {(project) => (
              <tr>
                <td
                  class={strongCell}
                  title={project.key === '(unknown)' ? 'Sessions without a detected project directory' : undefined}
                >
                  <button class={groupKeyButton} type="button" onClick={() => props.onProjectFilter(project.key)}>
                    {project.key}
                  </button>
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

const fieldFilterLabels: Record<FieldFilterKey, string> = {
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
};

const FilterPill = (props: { label: string; value: string; onClear: () => void }) => (
  <button
    class={activeFilterButton}
    type="button"
    title={`Clear ${props.label} filter`}
    onClick={() => props.onClear()}
  >
    {props.label}: {props.value} ×
  </button>
);

export const Dashboard = () => {
  const isDemo = isDemoReportPayload();
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const updateSearch = (updater: (current: DashboardSearch) => DashboardSearch) =>
    void navigate({ search: updater(search()), replace: true });
  const query = () => search().q;
  const harness = () => search().harness;
  const fieldFilters = () => search().filters;
  const sorting = createMemo(() => sortingStateFromSearch(search().sort));
  const columnVisibility = createMemo(() => columnVisibilityFromDiff(search().cols));
  const generatedAt = new Date(payload.generatedAt);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const harnesses = createMemo(() => ['all', ...new Set(reportRows.map((row) => row.harness))]);
  const filterSnapshot = createMemo(() => createFilterSnapshot(query(), harness(), fieldFilters()));
  const timelineRows = createMemo(() => {
    const filters = filterSnapshot();
    return reportRows.filter((row) => matchesFilterSnapshot(row, filters));
  });
  const initialRange = search().range;
  const dateRange = createDateRangeController({
    generatedAt,
    rows: timelineRows,
    defaultFrom: toDateInputValue(startOfDay(shiftCalendarDays(generatedAt, -6))),
    defaultTo: toDateInputValue(generatedAt),
    formatDate: fmtDateOnly,
    initialMode: initialRange.mode,
    ...(initialRange.from ? { initialFrom: initialRange.from } : {}),
    ...(initialRange.to ? { initialTo: initialRange.to } : {}),
  });
  const [tableDateBounds, setTableDateBounds] = createSignal<DateBounds>(dateRange.bounds());
  const searchRangeFromDateRange = (): DashboardSearch['range'] => {
    const mode = dateRange.mode();
    if (mode !== 'custom') return { mode };
    const values = dateRange.inputValues();
    return {
      mode,
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
    };
  };
  const commitTableDateRange = () => {
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, range: searchRangeFromDateRange() }));
  };
  createEffect(() => {
    const range = search().range;
    untrack(() => {
      const values = dateRange.inputValues();
      const matchesRange =
        dateRange.mode() === range.mode &&
        (range.mode !== 'custom' || (values.from === (range.from ?? '') && values.to === (range.to ?? '')));
      if (!matchesRange) dateRange.setRange(range.mode, range.from, range.to);
      setTableDateBounds(dateRange.bounds());
    });
  });
  const tableFilteredRows = createMemo(() => {
    const filters = filterSnapshot();
    const bounds = tableDateBounds();
    return reportRows.filter((row) => matchesFilterSnapshotAndDate(row, filters, bounds));
  });
  const tableRows = tableFilteredRows;
  // The drawer closes by itself when its row leaves the filtered set.
  const selectedRow = createMemo(() => tableFilteredRows().find((row) => rowKey(row) === selectedKey()) ?? null);
  createEffect(() => {
    if (!selectedRow()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedKey(null);
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });
  const visibleSummary = createMemo(() => {
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return buildReportSummary(reportRows, (row) => matchesFilterSnapshotAndDate(row, filters, bounds));
  });
  const modelGroups = createMemo(() => {
    if (search().tab !== 'models') return [];
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      reportRows,
      (row) => matchesFilterSnapshotAndDate(row, filters, bounds),
      (row) => row.modelKey,
      visibleSummary().totalCost,
    );
  });
  const providerGroups = createMemo(() => {
    if (search().tab !== 'providers') return [];
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      reportRows,
      (row) => matchesFilterSnapshotAndDate(row, filters, bounds),
      (row) => row.providerDisplay,
      visibleSummary().totalCost,
    );
  });
  const harnessGroups = createMemo(() => {
    if (search().tab !== 'harnesses') return [];
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return buildAnalyticsGroups(
      reportRows,
      (row) => matchesFilterSnapshotAndDate(row, filters, bounds),
      (row) => row.harness,
      visibleSummary().totalCost,
    );
  });
  const projectGroupRows = createMemo(() => {
    if (search().tab !== 'projects') return [];
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return buildProjectGroups(reportRows, (row) => matchesFilterSnapshotAndDate(row, filters, bounds));
  });
  const hiddenCount = createMemo(() => reportRows.length - visibleSummary().sessionCount);
  const exportRows = () => {
    const filters = filterSnapshot();
    const bounds = dateRange.bounds();
    return reportRows
      .filter((row) => matchesFilterSnapshotAndDate(row, filters, bounds))
      .sort(compareRows(sorting()));
  };
  const toggleSelected = (row: DashboardRow) =>
    setSelectedKey((current) => (current === rowKey(row) ? null : rowKey(row)));
  const setQuery = (q: string) => updateSearch((current) => ({ ...current, q }));
  const setHarness = (nextHarness: string) => updateSearch((current) => ({ ...current, harness: nextHarness }));
  const setFieldFilters = (updater: Updater<FieldFilters>) =>
    updateSearch((current) => ({ ...current, filters: applyTableUpdate(updater, current.filters) }));
  const setFieldFilter = (key: FieldFilterKey, value: string) =>
    setFieldFilters((current) => ({ ...current, [key]: value }));
  const clearFieldFilter = (key: FieldFilterKey) =>
    setFieldFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const clearFilters = () => {
    dateRange.clear();
    setTableDateBounds(dateRange.bounds());
    updateSearch((current) => ({ ...current, filters: {}, harness: 'all', q: '', range: { mode: 'all' } }));
  };
  const handleSortingChange: OnChangeFn<SortingState> = (updater) =>
    updateSearch((current) => ({
      ...current,
      sort: sortFromSortingState(applyTableUpdate(updater, sortingStateFromSearch(current.sort))),
    }));
  const handleColumnVisibilityChange: OnChangeFn<VisibilityState> = (updater) =>
    updateSearch((current) => {
      const nextVisibility = applyTableUpdate(updater, columnVisibilityFromDiff(current.cols));
      return { ...current, cols: columnDiffFromVisibility(nextVisibility) };
    });
  const setTab = (tab: string) => {
    if (!isDashboardTab(tab)) return;
    updateSearch((current) => ({ ...current, tab }));
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
      ...(a.rtkSaved
        ? [
            {
              label: 'RTK savings',
              value: fmtPct(a.rtkInput ? (a.rtkSaved / a.rtkInput) * 100 : 0),
              hint: [
                `${fmtNum(a.rtkSaved)} tokens saved in matched sessions`,
                `${fmtNum(a.rtkInput)} RTK input tokens before filtering`,
                `${fmtNum(a.rtkOutput)} RTK output tokens after filtering`,
              ].join('\n'),
            },
          ]
        : []),
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
                  Generated {fmtDate(payload.generatedAt)} · {fmtNum(visibleSummary().sessionCount)} of{' '}
                  {fmtNum(reportRows.length)} sessions
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
          <TimeRangeControl rows={timelineRows()} dateRange={dateRange} onDateRangeCommit={commitTableDateRange} />

          <div class={filterSummary}>
            <span class={summaryPill}>
              {fmtNum(visibleSummary().sessionCount)} / {fmtNum(reportRows.length)} sessions
            </span>
            <Show when={hiddenCount() > 0}>
              <span>{fmtNum(hiddenCount())} hidden by filters</span>
            </Show>
            <div class={activeFilters}>
              <Show when={harness() !== 'all'}>
                <FilterPill label="Harness" value={harness()} onClear={() => setHarness('all')} />
              </Show>
              <For each={Object.entries(fieldFilters()) as [FieldFilterKey, string][]}>
                {([key, value]) => (
                  <FilterPill label={fieldFilterLabels[key]} value={value} onClear={() => clearFieldFilter(key)} />
                )}
              </For>
            </div>
          </div>

          <div class={metricGrid}>
            <For each={metrics()}>{(metric) => <MetricTile {...metric} />}</For>
          </div>

          <Tabs.Root
            value={search().tab}
            class={tabsRoot}
            lazyMount
            unmountOnExit
            onValueChange={(details) => setTab(details.value)}
          >
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
                rows={tableRows()}
                selectedKey={selectedKey()}
                sorting={sorting()}
                columnVisibility={columnVisibility()}
                onSortingChange={handleSortingChange}
                onColumnVisibilityChange={handleColumnVisibilityChange}
                onSelect={toggleSelected}
                onHarnessFilter={setHarness}
                onFieldFilter={setFieldFilter}
                onClearFilters={clearFilters}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class={section}>
              <GroupPanel
                title="By model"
                groups={modelGroups()}
                countLabel="models"
                onFilter={(value) => setFieldFilter('model', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="providers" class={section}>
              <GroupPanel
                title="By provider"
                groups={providerGroups()}
                countLabel="providers"
                harnessTones
                onFilter={(value) => setFieldFilter('provider', value)}
              />
            </Tabs.Content>
            <Tabs.Content value="harnesses" class={section}>
              <GroupPanel
                title="By harness"
                groups={harnessGroups()}
                countLabel="harnesses"
                harnessTones
                onFilter={setHarness}
              />
            </Tabs.Content>
            <Tabs.Content value="projects" class={section}>
              <ProjectSummary
                groups={projectGroupRows()}
                onProjectFilter={(value) => setFieldFilter('project', value)}
              />
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
