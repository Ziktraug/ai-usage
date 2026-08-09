import { css } from '@ai-usage/design-system/css';

export const executiveGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(18rem, 0.85fr) minmax(0, 1.35fr)' },
  gap: { base: '24px', lg: '40px' },
  alignItems: 'start',
  minW: 0,
});

export const editorialSection = css({
  display: 'grid',
  gap: { base: '16px', md: '20px' },
  minW: 0,
  py: { base: '18px', md: '24px' },
  '& > header': {
    display: 'grid',
    gap: '4px',
  },
  '& h2': {
    m: 0,
    fontSize: { base: '18px', md: '20px' },
    fontWeight: 650,
    lineHeight: 1.25,
  },
  '& > header > p': {
    m: 0,
  },
});

export const sectionDivider = css({
  borderTop: '1px solid token(colors.line)',
  pt: { base: '22px', md: '28px' },
});

export const metricStrip = css({
  display: 'grid',
  gridTemplateColumns: {
    base: '1fr',
    md: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(4, minmax(0, 1fr))',
  },
  gap: { base: '10px', md: '16px 24px', lg: '20px' },
  alignItems: 'stretch',
  minW: 0,
  '& > *': {
    minW: 0,
  },
});

export const containedInteractive = css({
  position: 'relative',
  minW: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
});

export const numericDisplay = css({
  textStyle: 'numeric',
  color: 'ink',
  fontSize: { base: '40px', md: '52px' },
  fontWeight: 650,
  lineHeight: 0.98,
  overflowWrap: 'anywhere',
});

export const executiveCaption = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  m: 0,
});

export const executiveEssentialLabel = css({
  textStyle: 'label',
  color: 'ink',
  fontSize: '11px',
  lineHeight: 1.35,
});
