import { css } from '@ai-usage/design-system/css';

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
