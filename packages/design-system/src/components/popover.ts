import { css } from '@ai-usage/design-system/css';

export const popoverContent = css({
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

export const popoverHeader = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
  color: 'muted',
  fontSize: '12px',
});

export const popoverGrid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: '6px',
});

export const columnToggle = css({
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

export const columnToggleInput = css({
  accentColor: 'token(colors.accent)',
});

export const columnToggleText = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
