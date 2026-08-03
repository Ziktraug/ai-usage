import { css } from '@ai-usage/design-system/css';

export const controls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: 'space-between',
  mb: '10px',
});
export const presetGroup = css({ display: 'flex', flexWrap: 'wrap', gap: '6px', border: 0, m: 0, p: 0 });
export const controlButton = css({
  minH: '36px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  '&[aria-pressed=true]': { borderColor: 'accent', bg: 'accentTint', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const popoverGrid = css({ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' });
export const surface = css({
  h: 'var(--session-surface-height, 520px)',
  minH: '188px',
  overflow: 'auto',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});
export const table = css({
  w: '100%',
  minW: '720px',
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
  fontSize: '13px',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    bg: 'surface',
    color: 'muted',
    px: '12px',
    py: '10px',
    borderBottom: '1px solid token(colors.line)',
    textAlign: 'left',
  },
  '& td': { px: '12px', py: '10px', borderBottom: '1px solid token(colors.line)', overflow: 'hidden' },
  '& tr[data-selected=true] td': { bg: 'accentTint' },
  '& tbody tr': { h: '43px', cursor: 'pointer' },
  '& tbody tr:focus-visible': { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
});
export const sortButton = css({
  display: 'inline-flex',
  gap: '4px',
  alignItems: 'center',
  w: '100%',
  border: 0,
  bg: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'inherit',
});
export const numeric = css({ textAlign: 'right!', fontVariantNumeric: 'tabular-nums' });
export const sessionCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });
export const expandButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '28px',
  h: '28px',
  mr: '4px',
  border: 0,
  bg: 'transparent',
  color: 'muted',
  cursor: 'pointer',
});
export const mobileList = css({ display: 'grid', gap: '10px', m: 0, p: '10px', listStyle: 'none' });
export const mobileCard = css({
  display: 'grid',
  gap: '10px',
  minH: '168px',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  '&[data-selected=true]': { borderColor: 'accent', bg: 'accentTint' },
});
export const mobileHeader = css({ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' });
export const mobileOpen = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '12px',
  border: 0,
  bg: 'transparent',
  color: 'ink',
  textAlign: 'left',
  cursor: 'pointer',
  fontWeight: 600,
});
export const mobileMeta = css({ color: 'muted', fontSize: '12px' });
export const paging = css({ display: 'flex', justifyContent: 'center', p: '10px', color: 'muted', fontSize: '12px' });
export const empty = css({ p: '28px', color: 'muted', textAlign: 'center' });
export const mobileSort = css({ display: 'flex', gap: '8px', alignItems: 'center' });
export const select = css({
  minH: '36px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  px: '8px',
});
