import { css } from '@ai-usage/design-system/css';

export const tooltipContent = css({
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
