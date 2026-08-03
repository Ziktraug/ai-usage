import { css } from '@ai-usage/design-system/css';

export const stack = css({ display: 'grid', gap: '12px' });
export const compactStack = css({ display: 'grid', gap: '7px' });
export const panelHeader = css({ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'start' });
export const heading = css({ fontWeight: 700 });
export const subheading = css({ color: 'muted', fontSize: '12px' });
export const muted = css({ color: 'muted', fontSize: '12px' });
export const strong = css({ fontWeight: 650 });
export const pathText = css({ fontFamily: 'mono', fontSize: '11px', color: 'muted', overflowWrap: 'anywhere' });
export const pill = css({
  display: 'inline-flex',
  alignItems: 'center',
  w: 'fit-content',
  px: '7px',
  py: '2px',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
});
export const infoPill = css({ bg: 'accentTint', color: 'accent' });
export const warningPill = css({ bg: 'status.warnSoft', color: 'status.warn' });
export const dangerPill = css({ bg: 'status.dangerSoft', color: 'status.danger' });
export const button = css({
  appearance: 'none',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '10px',
  py: '7px',
  cursor: 'pointer',
  fontSize: '12px',
  _hover: { borderColor: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'default', opacity: 0.5 },
});
export const primaryButton = css({ bg: 'accent', color: 'surface', borderColor: 'accent' });
export const activeButton = css({ bg: 'accentTint', borderColor: 'accent', color: 'accent' });
export const actionRow = css({ display: 'flex', flexWrap: 'wrap', gap: '8px' });
export const diagnosticRow = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
  p: '8px 0',
  border: 0,
  borderTop: '1px solid token(colors.line)',
});
export const metricGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
  gap: '10px',
});
export const metricButton = css({
  appearance: 'none',
  display: 'grid',
  gap: '8px',
  minH: '88px',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  color: 'ink',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { borderColor: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'default' },
  '&[data-active=true]': { borderColor: 'accent', boxShadow: '0 0 0 1px token(colors.accent)' },
});
export const metricValue = css({ fontSize: '23px', lineHeight: 1, fontWeight: 650 });
export const dangerValue = css({ color: 'status.danger' });
export const warningValue = css({ color: 'status.warn' });
export const disclosure = css({ p: 0, overflow: 'hidden' });
export const disclosureSummary = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '12px 0',
  cursor: 'pointer',
});
export const filterBar = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' });
export const searchInput = css({
  minW: { base: '100%', md: '190px' },
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  px: '10px',
  py: '7px',
});
export const tableWrap = css({ minH: 'auto', overflowX: 'auto', display: { base: 'none', md: 'block' } });
export const table = css({ w: '100%', minW: '860px', borderCollapse: 'collapse' });
export const tableCell = css({ p: '10px', borderBottom: '1px solid token(colors.line)', verticalAlign: 'middle' });
export const stickyCell = css({
  position: 'sticky',
  left: 0,
  zIndex: 1,
  minW: '320px',
  bg: 'surface',
  textAlign: 'left',
  borderRight: '1px solid token(colors.line)',
});
export const mobileCards = css({ display: { base: 'grid', md: 'none' }, gap: '10px', m: 0, p: 0, listStyle: 'none' });
export const mobileCard = css({
  display: 'grid',
  gap: '12px',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});
export const skillTop = css({ display: 'flex', alignItems: 'center', gap: '8px', minW: 0 });
export const skillName = css({ color: 'inherit', fontWeight: 650, overflowWrap: 'anywhere' });
export const disabledName = css({ color: 'muted', textDecoration: 'line-through' });
export const switchButton = css({
  appearance: 'none',
  position: 'relative',
  w: '32px',
  h: '18px',
  flexShrink: 0,
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  cursor: 'pointer',
  _after: {
    content: '""',
    position: 'absolute',
    top: '2px',
    left: '2px',
    w: '12px',
    h: '12px',
    borderRadius: 'full',
    bg: 'muted',
  },
  '&[aria-checked=true]': {
    bg: 'status.okSoft',
    borderColor: 'status.ok',
    _after: { bg: 'status.ok', transform: 'translateX(14px)' },
  },
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
});
export const statusDot = css({ display: 'inline-block', w: '9px', h: '9px', borderRadius: 'full', bg: 'lineStrong' });
export const linkedDot = css({ bg: 'status.ok' });
export const missingDot = css({ bg: 'status.warn' });
export const brokenDot = css({ bg: 'status.danger' });
export const copyDot = css({ bg: 'accent' });
export const inactive = css({ opacity: 0.5 });
export const planPanel = css({
  display: 'grid',
  gap: '8px',
  p: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'accentTint',
});
export const planList = css({
  display: 'grid',
  gap: '3px',
  m: 0,
  pl: '18px',
  fontFamily: 'mono',
  fontSize: '12px',
  overflowWrap: 'anywhere',
});
export const notice = css({ p: '8px', borderRadius: 'sm', bg: 'accentTint', fontSize: '12px' });
export const errorNotice = css({ bg: 'status.dangerSoft', color: 'status.danger' });
