import { css } from '@ai-usage/design-system/css';

export const drawer = css({
  position: 'fixed',
  right: '0',
  bottom: '0',
  top: { base: 'auto', sm: '0' },
  left: { base: '0', sm: 'auto' },
  w: { base: '100%', sm: '440px' },
  maxW: '100vw',
  maxH: { base: '78dvh', sm: 'none' },
  display: 'flex',
  flexDirection: 'column',
  bg: 'surface',
  borderLeft: { base: '0', sm: '1px solid token(colors.line)' },
  borderTop: { base: '1px solid token(colors.line)', sm: '0' },
  roundedTop: { base: 'md', sm: '0' },
  boxShadow: 'overlay',
  zIndex: 40,
  animation: { base: 'sheetIn 0.2s ease-out', sm: 'drawerIn 0.18s ease-out' },
  _print: { display: 'none' },
});

export const drawerTop = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '10px',
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
});

export const drawerBody = css({
  display: 'grid',
  gap: '14px',
  alignContent: 'start',
  p: '16px 18px',
  overflowY: 'auto',
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
  gap: '6px',
});

export const drawerPosition = css({
  textStyle: 'numeric',
  color: 'faint',
  fontSize: '11px',
  mr: '4px',
});

export const drawerLegend = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '4px 12px',
  color: 'muted',
  fontSize: '11px',
});

export const drawerLegendItem = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
});

export const drawerLegendSwatch = css({
  w: '8px',
  h: '8px',
  borderRadius: '2px',
  flexShrink: 0,
});

export const drawerLegendValue = css({
  textStyle: 'numeric',
  color: 'ink',
  ml: 'auto',
});

export const drawerCompare = css({
  color: 'muted',
  fontSize: '12px',
});

export const drawerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
});
