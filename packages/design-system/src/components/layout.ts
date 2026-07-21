import { css } from '@ai-usage/design-system/css';

export const pageStack = css({
  display: 'grid',
  gap: '16px',
});

export const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

export const page = css({
  minHeight: '100vh',
  bg: 'canvas',
  color: 'ink',
  fontFamily: 'sans',
});

export const shell = css({
  maxWidth: '1380px',
  mx: 'auto',
  px: { base: '20px', md: '36px' },
  py: { base: '24px', md: '32px' },
});

export const header = css({
  display: 'grid',
  gap: '20px',
  pb: '16px',
});

export const headerTop = css({
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '16px',
});

export const headerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
  flexShrink: 1,
  maxW: '100%',
  _print: { display: 'none' },
});

export const headerNavigation = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
  maxW: '100%',
});

export const titleBlock = css({
  display: 'grid',
  gap: '8px',
  minW: 0,
});

export const eyebrowRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
});

export const eyebrow = css({
  textStyle: 'eyebrow',
  color: 'accent',
});

export const demoBadge = css({
  textStyle: 'label',
  display: 'inline-flex',
  alignItems: 'center',
  h: '20px',
  px: '8px',
  borderRadius: 'full',
  bg: 'accentSoft',
  color: 'accent',
});

export const title = css({
  fontSize: { base: '26px', md: '30px' },
  lineHeight: '1.1',
  fontWeight: 650,
  letterSpacing: '-0.02em',
});

export const meta = css({
  color: 'muted',
  fontSize: '13px',
  overflowWrap: 'anywhere',
});

export const filterSummary = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 12px',
  alignItems: 'center',
  color: 'muted',
  fontSize: '12px',
  pt: '14px',
});

export const summaryPill = css({
  textStyle: 'numeric',
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '11px',
  fontWeight: 600,
});

export const toolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: '0',
  zIndex: 20,
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  py: '12px',
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
  _print: { display: 'none' },
});

export const activeFilters = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
});

export const chartLegend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  justifyContent: { base: 'flex-start', sm: 'flex-end' },
});

export const section = css({
  display: 'grid',
  gap: '14px',
});

export const detailItem = css({
  display: 'grid',
  gap: '5px',
  minW: 0,
});

export const detailLabel = css({
  textStyle: 'label',
  color: 'muted',
});

export const detailValue = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
});

export const unavailableCell = css({ color: 'muted', fontStyle: 'italic' });
