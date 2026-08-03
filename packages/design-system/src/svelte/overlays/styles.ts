import { css } from '@ai-usage/design-system/css';

export const drawerClass = css({
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

export const popoverPositionerClass = css({ zIndex: 50 });

export const popoverContentClass = css({
  zIndex: 50,
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
  zIndex: 50,
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
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '14px',
  h: '14px',
  flexShrink: 0,
  borderRadius: 'full',
  border: '1px solid token(colors.lineStrong)',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: 1,
});

export const provenanceMarkerWarningClass = css({
  color: 'accent',
  borderColor: 'accent',
});
