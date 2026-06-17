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
  },
});

export const searchInput = cx(field, css({ flex: '1 1 240px', minW: '180px' }));
export const selectInput = cx(field, css({ flex: '0 1 180px', minW: '150px' }));
export const dateInput = cx(field, css({ flex: '0 1 150px', minW: '140px' }));

export const dateFieldGroup = css({
  display: 'grid',
  gap: '4px',
});

export const inlineFieldLabel = css({
  textStyle: 'label',
  color: 'muted',
});
