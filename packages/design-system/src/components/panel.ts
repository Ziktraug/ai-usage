import { css } from '@ai-usage/design-system/css';

export const panel = css({
  display: 'grid',
  gap: '14px',
  alignContent: 'start',
  p: { base: '16px', md: '20px 22px' },
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  minW: 0,
});

// Same reading rhythm as `panel` without the card chrome: for sections that are read, not operated.
// Containment stays reserved for interactive charts, tables, forms, alerts, and overlays.
export const passivePanel = css({
  display: 'grid',
  gap: '14px',
  alignContent: 'start',
  pt: '18px',
  borderTop: '1px solid token(colors.line)',
  minW: 0,
});

export const panelHeader = css({
  display: 'grid',
  gap: '5px',
});

export const panelTitle = css({
  fontSize: '16px',
  fontWeight: 650,
  letterSpacing: '-0.015em',
});

export const panelSub = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
});

export const groupPanel = css({
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  overflow: 'hidden',
});

export const groupHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'center',
  p: '14px 16px',
  borderBottom: '1px solid token(colors.line)',
});

export const groupTitle = css({
  fontSize: '14px',
  fontWeight: 650,
  overflowWrap: 'anywhere',
});

export const groupCount = css({
  textStyle: 'numeric',
  fontSize: '11px',
  color: 'faint',
});

export const groupRows = css({
  display: 'grid',
});

export const groupRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 96px',
  gap: '14px',
  alignItems: 'center',
  px: '16px',
  py: '12px',
  borderBottom: '1px solid token(colors.line)',
  _last: {
    borderBottom: '0',
  },
});

export const groupSub = css({
  color: 'muted',
  fontSize: '12px',
  mt: '2px',
});

export const groupValue = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 600,
});

export const groupPct = css({
  textStyle: 'numeric',
  fontSize: '11px',
  color: 'muted',
  mt: '2px',
});
