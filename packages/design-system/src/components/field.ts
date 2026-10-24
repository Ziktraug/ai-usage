import { css, cx } from '@ai-usage/design-system/css';

export const field = css({
  h: '36px',
  px: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
  _placeholder: {
    color: 'faint',
  },
  _focusVisible: {
    borderColor: 'accent',
    boxShadow: '0 0 0 3px token(colors.focusRing)',
    // Forced colours drop the halo and repaint the border, so the focus draws a system-colour
    // ring in the halo's footprint instead.
    _highContrast: { outline: '2px solid Highlight', outlineOffset: '1px' },
  },
});

export const searchInput = cx(field, css({ flex: '1 1 240px', minW: '180px' }));
