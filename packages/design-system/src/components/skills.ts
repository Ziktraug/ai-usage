import { css } from '@ai-usage/design-system/css';

export const skillsDisclosurePanel = css({
  overflow: 'hidden',
});

export const skillsDisclosureSummary = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '14px 16px',
  cursor: 'pointer',
});

export const skillsPathText = css({
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'muted',
  overflowWrap: 'anywhere',
});

export const skillsReconcilePlanList = css({
  display: 'grid',
  gap: '3px',
  m: 0,
  pl: '18px',
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'ink',
  overflowWrap: 'anywhere',
});
