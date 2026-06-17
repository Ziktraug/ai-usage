import { css } from '@ai-usage/design-system/css';

export const empty = css({
  minH: '160px',
  display: 'grid',
  placeItems: 'center',
  color: 'muted',
  fontSize: '13px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
});

export const emptyPanel = css({
  minH: '160px',
  display: 'grid',
  placeItems: 'center',
  color: 'muted',
  fontSize: '13px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
});

export const unavailablePanel = css({
  mt: '20px',
  minH: '180px',
  display: 'grid',
  alignContent: 'center',
  gap: '8px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  p: '22px',
});

export const unavailableTitle = css({
  fontSize: '16px',
  fontWeight: 650,
});

export const unavailableText = css({
  color: 'muted',
  fontSize: '13px',
  maxW: '620px',
});

export const emptyActions = css({
  display: 'grid',
  gap: '12px',
  justifyItems: 'center',
});
