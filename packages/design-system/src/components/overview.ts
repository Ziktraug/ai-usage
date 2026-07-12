import { css } from '@ai-usage/design-system/css';

export const overviewGrid = css({
  display: 'grid',
  gap: '14px',
});

export const advancedAnalysis = css({
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  overflow: 'hidden',
});

export const advancedAnalysisSummary = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'auto 1fr' },
  gap: '4px 12px',
  alignItems: 'center',
  p: '14px 16px',
  cursor: 'pointer',
  color: 'ink',
  fontWeight: 650,
  _hover: {
    bg: 'surfaceMuted',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
});

export const advancedAnalysisSummaryText = css({
  color: 'muted',
  fontSize: '12px',
  fontWeight: 400,
});

export const advancedAnalysisContent = css({
  p: '0 14px 14px',
});

export const twoColumns = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  gap: '14px',
  alignItems: 'stretch',
  '& > :only-child': {
    gridColumn: '1 / -1',
  },
});

export const heroPanel = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1.2fr) minmax(0, 1fr)' },
  gap: '18px 32px',
  alignItems: 'center',
  p: '20px 22px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

export const heroLabel = css({
  textStyle: 'eyebrow',
  color: 'accent',
});

export const heroValue = css({
  textStyle: 'numeric',
  fontSize: { base: '30px', md: '38px' },
  lineHeight: '1.05',
  fontWeight: 650,
  mt: '8px',
});

export const heroText = css({
  color: 'muted',
  fontSize: '13px',
  mt: '6px',
});

export const heroSide = css({
  display: 'grid',
  gap: '10px',
});

export const heroMultiple = css({
  textStyle: 'numeric',
  display: 'inline-flex',
  alignItems: 'center',
  h: '24px',
  px: '10px',
  borderRadius: 'full',
  bg: 'accentSoft',
  color: 'accent',
  fontSize: '12px',
  fontWeight: 650,
  justifySelf: 'start',
});

export const heroLegend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 16px',
  color: 'muted',
  fontSize: '11px',
});

export const heroLegendValue = css({
  textStyle: 'numeric',
  color: 'ink',
  ml: '5px',
});

export const anatomyLegend = css({
  display: 'grid',
  gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
  gap: '6px 12px',
  color: 'muted',
  fontSize: '11px',
});

export const anatomyLegendItem = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
});

export const anatomyLegendSwatch = css({
  w: '8px',
  h: '8px',
  borderRadius: '2px',
  flexShrink: 0,
});

export const anatomyLegendValue = css({
  textStyle: 'numeric',
  color: 'ink',
  ml: 'auto',
});

export const anatomyHeadline = css({
  fontSize: '13px',
  color: 'muted',
  '& strong': {
    textStyle: 'numeric',
    color: 'ink',
    fontWeight: 650,
  },
});

export const rtkNote = css({
  display: 'grid',
  gap: '2px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  fontSize: '12px',
  color: 'muted',
  '& strong': {
    textStyle: 'numeric',
    color: 'ink',
    fontWeight: 650,
  },
});

export const heatBody = css({
  display: 'flex',
  gap: '8px',
  minW: 0,
});

export const heatWeekdays = css({
  display: 'grid',
  gridTemplateRows: { base: 'repeat(7, 18px)', md: 'repeat(7, 12px)' },
  gap: '3px',
  pt: '19px',
  color: 'muted',
  fontSize: '9px',
  fontFamily: 'mono',
  textAlign: 'right',
});

export const heatScroll = css({
  overflowX: 'auto',
  pb: '4px',
});

export const heatMonths = css({
  display: 'grid',
  gridAutoFlow: 'column',
  gridAutoColumns: { base: '18px', md: '12px' },
  gap: '3px',
  h: '16px',
  color: 'muted',
  fontSize: '10px',
  fontFamily: 'mono',
  whiteSpace: 'nowrap',
});

export const heatGrid = css({
  display: 'grid',
  gridAutoFlow: 'column',
  gridAutoColumns: { base: '18px', md: '12px' },
  gap: '3px',
});

export const heatWeekColumn = css({
  display: 'grid',
  gridTemplateRows: { base: 'repeat(7, 18px)', md: 'repeat(7, 12px)' },
  gap: '3px',
});

export const heatCell = css({
  w: { base: '18px', md: '12px' },
  h: { base: '18px', md: '12px' },
  p: 0,
  border: '0',
  borderRadius: '3px',
  cursor: 'pointer',
  transition: 'transform 0.1s',
  _hover: {
    transform: 'scale(1.25)',
  },
  _focusVisible: {
    outline: '1px solid token(colors.accent)',
    outlineOffset: '1px',
  },
});

export const heatCellZero = css({ bg: 'track' });

export const heatCellToday = css({
  outline: '1px solid token(colors.accent)',
  outlineOffset: '1px',
});

export const heatLegend = css({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  color: 'muted',
  fontSize: '10px',
});

export const heatLegendCell = css({
  w: '10px',
  h: '10px',
  borderRadius: '3px',
});

export const scatterWrap = css({
  position: 'relative',
  h: '240px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  overflow: 'hidden',
});

export const punchGrid = css({
  display: 'grid',
  gridTemplateColumns: '34px repeat(24, minmax(10px, 1fr))',
  gap: '2px',
  alignItems: 'center',
});

export const punchDayLabel = css({
  color: 'muted',
  fontSize: '9px',
  fontFamily: 'mono',
  textAlign: 'right',
  pr: '6px',
});

export const punchCell = css({
  position: 'relative',
  h: '18px',
  display: 'grid',
  placeItems: 'center',
});

export const punchDot = css({
  borderRadius: 'full',
});

export const punchHourLabel = css({
  color: 'muted',
  fontSize: '9px',
  fontFamily: 'mono',
  textAlign: 'center',
});

export const recordsGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
  gap: '10px',
});

export const recordCard = css({
  appearance: 'none',
  textAlign: 'left',
  minH: '92px',
  p: '14px 16px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  display: 'grid',
  alignContent: 'space-between',
  gap: '8px',
  minW: 0,
  cursor: 'pointer',
  transition: 'border-color 0.15s',
  _hover: {
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const recordLabel = css({
  textStyle: 'label',
  color: 'muted',
});

export const recordValue = css({
  textStyle: 'numeric',
  fontSize: '20px',
  fontWeight: 600,
});

export const recordSub = css({
  color: 'muted',
  fontSize: '11px',
  lineClamp: 1,
});

export const topList = css({
  display: 'grid',
});

export const topRank = css({
  textStyle: 'numeric',
  color: 'faint',
  fontSize: '12px',
});

export const topTitle = css({
  fontSize: '13px',
  fontWeight: 600,
  lineClamp: 1,
  overflowWrap: 'anywhere',
});

export const topMoney = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 600,
});
