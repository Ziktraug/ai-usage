import { css } from '@ai-usage/design-system/css';
export const memoryStack = css({ display: 'grid', gap: '16px', minW: 0 });
export const memoryPanel = css({
  display: 'grid',
  gap: '14px',
  p: '16px',
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  minW: 0,
});
export const memoryCopy = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6, overflowWrap: 'anywhere' });
export const memoryHeading = css({ fontSize: '17px', fontWeight: 700, color: 'ink' });
export const memoryRow = css({ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'end' });
export const memoryField = css({
  display: 'grid',
  gap: '5px',
  flex: '1 1 140px',
  minW: 0,
  fontSize: '12px',
  color: 'muted',
});
export const memoryInput = css({
  minH: '44px',
  p: '8px 10px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  minW: 0,
  maxW: 'full',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
const memoryButtonStyle = css.raw({
  minH: '44px',
  p: '8px 12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'ink',
  fontSize: '12px',
  fontWeight: 700,
  cursor: 'pointer',
  _hover: { bg: 'accentSoft' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { opacity: 0.55, cursor: 'not-allowed' },
});
export const memoryButton = css(memoryButtonStyle);
export const memoryCurrentButton = css(memoryButtonStyle, { bg: 'accentSoft', borderColor: 'accent' });
