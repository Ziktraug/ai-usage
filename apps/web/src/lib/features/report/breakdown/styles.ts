import { css } from '@ai-usage/design-system/css';

export const stack = css({ display: 'grid', gap: '14px', minW: 0 });
export const row = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
export const panel = css({
  display: 'grid',
  gap: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  p: '14px',
  bg: 'surface',
});
export const panelHeader = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'space-between',
});
export const title = css({ fontSize: '16px', fontWeight: 700 });
export const muted = css({ color: 'muted', fontSize: '12px' });
export const field = css({
  h: '36px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '12px',
  fontSize: '13px',
  outline: 'none',
  _placeholder: { color: 'faint' },
  _focusVisible: { borderColor: 'accent', boxShadow: '0 0 0 3px token(colors.focusRing)' },
});
export const button = css({
  appearance: 'none',
  minH: '32px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '10px',
  fontSize: '12px',
  fontWeight: 650,
  cursor: 'pointer',
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'not-allowed', opacity: 0.5 },
});
export const selectedButton = css({ borderColor: 'accent', bg: 'accentTint', color: 'ink' });
export const pill = css({
  appearance: 'none',
  minH: '28px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'ink',
  px: '10px',
  fontSize: '11px',
  cursor: 'pointer',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const list = css({ display: 'grid', gap: '8px' });
export const item = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' },
  gap: '10px',
  alignItems: 'center',
  borderTop: '1px solid token(colors.line)',
  pt: '10px',
});
export const partialBarTrack = css({ border: '1px dashed token(colors.accent)' });
export const toolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: 0,
  zIndex: 20,
  display: 'flex',
  flexDirection: { base: 'column', sm: 'row' },
  flexWrap: { base: 'nowrap', sm: 'wrap' },
  gap: { base: '8px', sm: '10px' },
  alignItems: 'center',
  py: { base: '8px', sm: '12px' },
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
  _print: { display: 'none' },
  '& > input': {
    flex: { base: 'none', sm: '1 1 240px' },
    minW: { base: 0, sm: '180px' },
    w: { base: 'full', sm: 'auto' },
  },
});
export const controls = css({
  display: { base: 'grid', sm: 'contents' },
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  w: { base: 'full', sm: 'auto' },
  gap: { base: '8px', sm: '0' },
  alignItems: 'center',
  '& > *': {
    minW: 0,
    w: { base: 'full', sm: 'auto' },
  },
  '& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } },
});

export const table = css({ w: 'full', borderCollapse: 'collapse', fontSize: '12px' });
export const tableCell = css({ borderTop: '1px solid token(colors.line)', p: '6px', textAlign: 'left' });
