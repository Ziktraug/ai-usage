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

export const advancedAnalysisHeader = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'auto 1fr' },
  gap: '4px 12px',
  alignItems: 'center',
  p: '14px 16px',
  color: 'ink',
  fontWeight: 650,
  '& h2': {
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    m: 0,
  },
});

export const advancedAnalysisHeaderText = css({
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

export const anatomyLegend = css({
  display: 'grid',
  color: 'muted',
  fontSize: '11px',
  m: 0,
});

export const anatomyLegendItem = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '8px 16px',
  minW: 0,
  py: '6px',
  '& + &': {
    borderTop: '1px solid token(colors.line)',
  },
});

export const anatomyLegendLabel = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
});

export const anatomyLegendValues = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(72px, auto) 52px',
  gap: '12px',
  justifyItems: 'end',
  m: 0,
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
});

export const anatomyLegendPercentage = css({
  textStyle: 'numeric',
  color: 'muted',
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

export const heatDayControl = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'end',
  gap: '8px 12px',
  pt: '10px',
});

export const heatDayDetail = css({
  minW: 0,
  pb: '8px',
  color: 'muted',
  fontSize: '11px',
  overflowWrap: 'anywhere',
});

export const PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX = 24;
const PUNCHCARD_INTERACTIVE_TARGET_SIZE = `${PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX}px`;

export const punchGrid = css({
  display: 'grid',
  gridTemplateColumns: `34px repeat(24, ${PUNCHCARD_INTERACTIVE_TARGET_SIZE})`,
  gap: '2px',
  alignItems: 'center',
  overflowX: 'auto',
  overflowY: 'hidden',
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
  display: 'grid',
  w: PUNCHCARD_INTERACTIVE_TARGET_SIZE,
  h: PUNCHCARD_INTERACTIVE_TARGET_SIZE,
  placeItems: 'center',
});

export const punchCellButton = css({
  appearance: 'none',
  bg: 'transparent',
  border: '0',
  borderRadius: 'sm',
  cursor: 'pointer',
  display: 'grid',
  h: 'full',
  p: 0,
  placeItems: 'center',
  w: 'full',
  _hover: {
    '& [data-punchcard-cell-fill]': {
      transform: 'scale(1.6)',
    },
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
});

export const punchDot = css({
  w: '10px',
  h: '10px',
  borderRadius: 'full',
  transition: 'transform 0.16s ease-out',
});

export const punchIntensityKey = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '5px',
  pt: '10px',
  color: 'muted',
  fontSize: '10px',
});

export const punchIntensityKeyCell = css({
  w: '10px',
  h: '10px',
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
