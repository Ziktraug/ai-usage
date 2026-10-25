import { css } from '@ai-usage/design-system/css';

export { workButton, workHeading, workMuted, workPanel, workRow, workStack } from '../work/work-styles';

export const sectionIntro = css({ display: 'grid', gap: '6px', minW: 0 });
export const sectionTitle = css({ color: 'ink', fontSize: '18px', fontWeight: 550, letterSpacing: '-0.02em' });
export const fixedText = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.6,
  pl: '10px',
  borderLeft: '2px solid token(colors.lineStrong)',
  overflowWrap: 'anywhere',
});
export const monoText = css({ fontFamily: 'mono', fontSize: '11px', color: 'muted', overflowWrap: 'anywhere' });

// --- Forms --------------------------------------------------------------------------------------

export const fieldGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', sm: 'repeat(auto-fit, minmax(200px, 1fr))' },
  gap: '12px',
  minW: 0,
});
export const fieldLabel = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
  color: 'muted',
  fontSize: '12px',
  fontWeight: 600,
});
export const fieldInput = css({
  minH: '44px',
  w: 'full',
  minW: 0,
  px: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
  fontWeight: 400,
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { opacity: 0.6 },
});
export const fieldTextarea = css({
  minH: '72px',
  w: 'full',
  minW: 0,
  p: '10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
  fontWeight: 400,
  resize: 'vertical',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const fieldHint = css({ color: 'faint', fontSize: '11px', fontWeight: 400, lineHeight: 1.5 });
export const fieldError = css({ color: 'status.danger', fontSize: '12px', fontWeight: 400, lineHeight: 1.5 });
export const fieldsetFrame = css({
  display: 'grid',
  gap: '10px',
  minW: 0,
  m: 0,
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
});
export const fieldsetLegend = css({ color: 'muted', fontSize: '12px', fontWeight: 600, px: '4px' });
export const checkRow = css({ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', minW: 0 });
export const checkItem = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minH: '44px',
  color: 'ink',
  fontSize: '13px',
  fontWeight: 400,
  cursor: 'pointer',
  '& input': { w: '16px', h: '16px', m: 0, accentColor: 'token(colors.accent)' },
});
export const formActions = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minW: 0 });
export const primaryButton = css({
  minH: '44px',
  px: '14px',
  border: '1px solid token(colors.accent)',
  borderRadius: 'sm',
  bg: 'accentTint',
  color: 'accent',
  fontSize: '12px',
  fontWeight: 650,
  cursor: 'pointer',
  _hover: { bg: 'accentSoft' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { opacity: 0.55, cursor: 'default' },
});
export const dangerButton = css({
  minH: '44px',
  px: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'status.danger',
  fontSize: '12px',
  cursor: 'pointer',
  _hover: { borderColor: 'status.danger' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});

// --- Entries (declarations, rules, models) -------------------------------------------------------

export const entryList = css({ display: 'grid', gap: '16px', minW: 0 });
export const entryCard = css({
  display: 'grid',
  gap: '12px',
  minW: 0,
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
export const entryHeader = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minW: 0,
});
export const entryTitle = css({ color: 'ink', fontSize: '14px', fontWeight: 600, overflowWrap: 'anywhere' });

// --- Route status table and its card fallback --------------------------------------------------

export const tableFrame = css({
  display: { base: 'none', lg: 'block' },
  overflowX: 'auto',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
});
export const statusTable = css({
  w: 'full',
  borderCollapse: 'collapse',
  fontSize: '12px',
  lineHeight: 1.5,
  '& th': {
    position: 'sticky',
    top: 0,
    bg: 'surface',
    color: 'muted',
    textAlign: 'left',
    fontWeight: 600,
    py: '10px',
    px: '10px',
    borderBottom: '1px solid token(colors.line)',
    whiteSpace: 'nowrap',
  },
  '& td': {
    py: '10px',
    px: '10px',
    borderBottom: '1px solid token(colors.line)',
    verticalAlign: 'top',
    color: 'ink',
    overflowWrap: 'anywhere',
    minW: '120px',
  },
  '& tr:last-child td': { borderBottom: '0' },
});
/** The same frame for a table that has no card fallback (few columns, short cells). */
export const tableFrameAlways = css({
  display: 'block',
  overflowX: 'auto',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
});
export const cardList = css({ display: { base: 'grid', lg: 'none' }, gap: '12px', minW: 0 });
export const factList = css({ display: 'grid', gap: '8px', m: 0, p: 0, minW: 0 });
export const factTerm = css({ color: 'muted', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em' });
export const factValue = css({ m: 0, color: 'ink', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' });
/** A monospaced fact value, complete on its own: atoms that conflict resolve by stylesheet order. */
export const factMono = css({
  m: 0,
  fontFamily: 'mono',
  fontSize: '11px',
  lineHeight: 1.5,
  color: 'muted',
  overflowWrap: 'anywhere',
});
/** A block-level monospaced line under a cell title. */
export const cellMono = css({
  display: 'block',
  fontFamily: 'mono',
  fontSize: '11px',
  fontWeight: 400,
  color: 'muted',
  overflowWrap: 'anywhere',
});
export const rowHeader = css({ position: 'static', whiteSpace: 'normal' });
export const tableCaption = css({ textAlign: 'left', p: '10px', color: 'muted', fontSize: '12px' });
export const plainList = css({ m: 0, pl: '18px', display: 'grid', gap: '4px', fontSize: '12px', lineHeight: 1.5 });
export const compactList = css({ m: 0, p: 0, listStyleType: 'none', display: 'grid', gap: '4px' });

// --- Simulator result --------------------------------------------------------------------------

export const routeResult = css({
  display: 'grid',
  gap: '8px',
  minW: 0,
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
});
export const routeResultExcluded = css({ borderStyle: 'dashed' });
export const noticeStack = css({ display: 'grid', gap: '8px', minW: 0 });
