import { css } from '@ai-usage/design-system/css';

// Sync-local presentation styles keep the browser closure on the Svelte-safe
// design-system surface. Values intentionally match the legacy report layout.
export const actionRow = css({
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
});

export const panelHeader = css({ display: 'grid', gap: '2px' });
export const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });
export const right = css({ textAlign: 'right' });
export const numCell = css({ fontSize: '12px', textAlign: 'right', textStyle: 'numeric' });

export const statusPill = css({
  alignItems: 'center',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  display: 'inline-flex',
  fontSize: '11px',
  fontWeight: 650,
  h: '22px',
  lineHeight: 1,
  px: '8px',
  whiteSpace: 'nowrap',
});
export const statusPillOk = css({ bg: 'status.okSoft', borderColor: 'status.ok', color: 'status.ok' });
export const statusPillWarn = css({ bg: 'status.warnSoft', borderColor: 'status.warn', color: 'status.warn' });
export const statusPillInfo = css({ bg: 'surfaceMuted', borderColor: 'line', color: 'muted' });

export const ghostButton = css({
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _hover: { borderColor: 'accent', color: 'accent' },
  alignItems: 'center',
  appearance: 'none',
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  color: 'muted',
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: '12px',
  fontWeight: 600,
  justifyContent: 'center',
  px: '12px',
  py: '5px',
  transition: 'border-color 0.15s, color 0.15s',
});

export const table = css({
  '& td': {
    borderBottom: '1px solid token(colors.line)',
    px: '12px',
    py: '10px',
    verticalAlign: 'middle',
  },
  '& th': {
    bg: 'surface',
    borderBottom: '1px solid token(colors.line)',
    color: 'muted',
    px: '12px',
    py: '10px',
    position: 'sticky',
    textAlign: 'left',
    textStyle: 'label',
    top: 0,
    zIndex: 2,
  },
  '& tr:last-child td': { borderBottom: '0' },
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: '13px',
  minW: '1040px',
  tableLayout: 'fixed',
  width: '100%',
});
export const tableWrap = css({
  _print: { boxShadow: 'none', maxH: 'none', overflow: 'visible' },
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  boxShadow: 'card',
  maxH: 'var(--ai-usage-table-max-height, calc(100dvh - 240px))',
  minH: 'var(--ai-usage-table-min-height, 320px)',
  overflow: 'auto',
});
export const desktopTableSurface = css({ _print: { display: 'block' }, display: { base: 'none', md: 'block' } });
export const mobileSummarySurface = css({ _print: { display: 'none' }, display: { base: 'grid', md: 'none' } });
export const projectSummaryList = css({ gap: '10px', listStyle: 'none', m: 0, p: 0 });
export const projectSummaryCard = css({
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  boxShadow: 'card',
  display: 'grid',
  gap: '12px',
  p: '14px',
});
export const projectSummaryHeader = css({
  alignItems: 'start',
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
});
export const projectSummaryMetrics = css({
  display: 'grid',
  gap: '8px',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  m: 0,
});
export const projectSummaryMetric = css({
  '& dd': { color: 'muted', m: 0, textStyle: 'numeric' },
  '& dt': { color: 'faint', fontSize: '9px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' },
  display: 'grid',
  gap: '2px',
  m: 0,
  minW: 0,
});

export const headerTop = css({
  alignItems: 'flex-start',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '16px',
  justifyContent: 'space-between',
});
export const pageStack = css({ display: 'grid', gap: '16px' });
export const unavailablePanel = css({
  alignContent: 'center',
  bg: 'surface',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  display: 'grid',
  gap: '8px',
  minH: '180px',
  mt: '20px',
  p: '22px',
});
export const unavailableText = css({ color: 'muted', fontSize: '13px', maxW: '620px' });
