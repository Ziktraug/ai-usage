import { css } from '@ai-usage/design-system/css';

export const workStack = css({ display: 'grid', gap: '16px', minW: 0 });
export const workPanel = css({
  p: { base: '16px', md: '20px' },
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  minW: 0,
});
export const workRow = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', minW: 0 });
export const workMuted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere' });
export const workHeading = css({ color: 'ink', fontSize: '16px', fontWeight: 550, overflowWrap: 'anywhere' });
export const workButton = css({
  minH: '44px',
  px: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  color: 'ink',
  bg: 'surface',
  fontSize: '12px',
  cursor: 'pointer',
  _hover: { bg: 'surfaceMuted' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { opacity: 0.55, cursor: 'default' },
});
export const workLink = css({
  color: 'accent',
  minH: '44px',
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'underline',
  overflowWrap: 'anywhere',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const workInput = css({
  minH: '44px',
  p: '8px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  maxW: 'full',
});
