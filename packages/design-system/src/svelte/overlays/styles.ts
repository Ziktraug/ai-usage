import { css } from '@ai-usage/design-system/css';

export const drawerClass = css({
  position: 'fixed',
  right: '0',
  bottom: '0',
  top: { base: 'auto', md: '0' },
  left: { base: '0', md: 'auto' },
  w: { base: '100%', md: '440px' },
  maxW: '100vw',
  maxH: { base: '78dvh', md: 'none' },
  display: 'flex',
  flexDirection: 'column',
  bg: 'surface',
  borderLeft: { base: '0', md: '1px solid token(colors.line)' },
  borderTop: { base: '1px solid token(colors.line)', md: '0' },
  roundedTop: { base: 'md', md: '0' },
  boxShadow: 'overlay',
  zIndex: 60,
  _open: { animation: { base: 'sheetIn 0.2s ease-out', md: 'drawerIn 0.18s ease-out' } },
  _closed: { animation: 'none' },
  _print: { display: 'none' },
});

export const drawer = drawerClass;

export const drawerTop = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  alignItems: 'center',
  gap: '10px',
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
  flexShrink: 0,
  minW: 0,
});

export const drawerBody = css({
  display: 'grid',
  gap: '14px',
  alignContent: 'start',
  p: '16px 18px',
  pb: { base: 'calc(16px + env(safe-area-inset-bottom))', md: '18px' },
  flex: '1 1 auto',
  minH: 0,
  overflowY: 'auto',
  overscrollBehaviorY: 'contain',
  '& button, & a[href], & summary': { minH: '44px', minW: '44px' },
  '& a[href]': { display: 'inline-flex', alignItems: 'center' },
  '& input, & select, & textarea': { minH: '44px' },
});

export const drawerTitle = css({
  fontSize: '15px',
  fontWeight: 650,
  lineHeight: '1.35',
  overflowWrap: 'anywhere',
});

export const drawerGrid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '14px 12px',
});

export const drawerNav = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '6px',
  minW: 0,
  whiteSpace: 'nowrap',
  '& button': { minH: '44px', minW: '44px', flexShrink: 0 },
});

export const drawerPosition = css({
  display: { base: 'none', md: 'block' },
  textStyle: 'numeric',
  color: 'faint',
  fontSize: '11px',
  mr: '4px',
  flex: '0 1 auto',
  minW: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const drawerLegend = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '4px 12px',
  color: 'muted',
  fontSize: '11px',
});

export const drawerLegendItem = css({ display: 'flex', alignItems: 'center', gap: '6px', minW: 0 });

export const drawerLegendSwatch = css({ w: '8px', h: '8px', borderRadius: '2px', flexShrink: 0 });

export const drawerLegendValue = css({ textStyle: 'numeric', color: 'ink', ml: 'auto' });

export const drawerCompare = css({ color: 'muted', fontSize: '12px' });

export const drawerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  '& button, & a': { minH: '44px' },
});

export const popoverPositionerClass = css({ zIndex: 70 });

export const popoverContentClass = css({
  zIndex: 70,
  display: 'grid',
  gap: '10px',
  w: 'min(560px, calc(100vw - 32px))',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'overlay',
  animation: 'fadeIn 0.12s ease-out',
});

export const tooltipContentClass = css({
  p: '8px 12px',
  borderRadius: 'sm',
  bg: 'ink',
  color: 'canvas',
  fontSize: '12px',
  lineHeight: 1.5,
  whiteSpace: 'pre',
  boxShadow: 'overlay',
  zIndex: 70,
  _open: {
    animation: 'fadeIn 0.12s ease-out',
  },
});

export const provenanceCellClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  minW: 0,
});

export const provenanceMarkerClass = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '14px',
  h: '14px',
  flexShrink: 0,
  borderRadius: 'full',
  border: '1px solid token(colors.lineStrong)',
  bg: 'transparent',
  color: 'muted',
  cursor: 'help',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: 1,
  p: 0,
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});

export const provenanceMarkerWarningClass = css({
  color: 'accent',
  borderColor: 'accent',
});
