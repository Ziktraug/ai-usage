import { css } from '@ai-usage/design-system/css';

export const skillsDisclosurePanel = css({
  overflow: 'hidden',
  minW: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  p: '0',
  gap: '0',
  '& > div': { p: { base: '16px', md: '20px 22px' }, borderTop: '1px solid token(colors.line)' },
});

export const skillsDisclosureSummary = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '14px 16px',
  minH: '56px',
  listStyle: 'none',
  fontSize: '13px',
  '&::-webkit-details-marker': { display: 'none' },
  _after: { content: '"›"', color: 'muted', fontSize: '20px', lineHeight: 1, transition: 'transform 0.15s' },
  '[open] > &': { _after: { transform: 'rotate(90deg)' } },
  _hover: { bg: 'surfaceMuted' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-3px' },
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
