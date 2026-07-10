import { css, cx } from '@ai-usage/design-system/css';

export const timeRangePanel = css({
  display: 'grid',
  gap: '14px',
  mt: '14px',
  p: { base: '12px', sm: '14px 16px 16px' },
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

export const timeRangeHeader = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'max-content minmax(0, 1fr)' },
  gap: '12px',
  alignItems: 'start',
});

export const timeRangeTitle = css({
  fontSize: '14px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
});

export const timeRangeMeta = css({
  color: 'muted',
  fontSize: '12px',
  mt: '2px',
});

export const timeRangeSummary = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '6px 10px',
  mt: '6px',
});

export const timeRangeSummaryDates = css({
  display: 'inline-grid',
  gridTemplateColumns: 'auto auto auto',
  alignItems: 'center',
  gap: '7px',
  minW: 0,
  color: 'ink',
  fontSize: '13px',
  fontWeight: 650,
});

export const timeRangeArrow = css({
  color: 'faint',
  fontWeight: 500,
});

export const timeRangeDuration = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 600,
});

export const presetGroup = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px',
  justifyContent: 'flex-start',
  minW: 0,
  p: '2px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});

export const presetGroupShell = css({
  display: 'grid',
  gap: '3px',
  minW: 0,
  w: { base: '100%', md: 'auto' },
});

export const presetGroupLabel = css({
  color: 'faint',
  fontSize: '9px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  lineHeight: 1,
  px: '3px',
  textTransform: 'uppercase',
});

export const timeRangeViewControls = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(3, max-content)' },
  gap: '8px',
  alignItems: 'end',
  justifyContent: 'flex-start',
  pt: '2px',
});

export const dateEditRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'end',
});

export const timeSliderRoot = css({
  display: 'grid',
  gap: '10px',
});

export const timeSliderFrame = css({
  display: 'grid',
  gap: '10px',
});

export const timeSliderControl = css({
  position: 'relative',
  h: '118px',
});

export const timeChartToolbar = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px 10px',
});

export const timeChartZoomSummary = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 600,
});

export const timeChartZoomControls = css({
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: '4px',
});

export const timeChartZoomButton = css({
  appearance: 'none',
  h: '24px',
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'muted',
  cursor: 'pointer',
  fontSize: '11px',
  fontWeight: 650,
  lineHeight: 1,
  transition: 'border-color 0.15s, color 0.15s, transform 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'ink',
    transform: 'translateY(-1px)',
  },
  _focusVisible: {
    outline: '2px solid token(colors.ink)',
    outlineOffset: '2px',
  },
  _disabled: {
    cursor: 'not-allowed',
    opacity: 0.48,
    transform: 'none',
  },
});

export const timeSliderTrack = css({
  position: 'relative',
  h: '118px',
  border: '1px solid rgba(255, 255, 255, 0.04)',
  borderRadius: 'sm',
  bg: 'surface',
  overflow: 'hidden',
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
  _focusWithin: {
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
});

export const timeSliderBars = css({
  position: 'absolute',
  inset: '8px',
  display: 'flex',
  alignItems: 'flex-end',
  gap: '2px',
  pointerEvents: 'none',
  zIndex: 2,
});

export const timelineHoverLayer = css({
  appearance: 'none',
  position: 'absolute',
  inset: '8px',
  border: 0,
  p: 0,
  bg: 'transparent',
  cursor: 'default',
  pointerEvents: 'auto',
  zIndex: 2,
  '&[data-zoomed="true"]': {
    cursor: 'grab',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
  },
});

export const timeBucket = css({
  flex: '1 1 0',
  minW: '2px',
  h: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  gap: '1px',
});

export const timeBucketSegment = css({
  w: '100%',
  minH: '1px',
  borderRadius: '1px',
});

export const timeSliderRange = css({
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  zIndex: 3,
  borderRadius: 'full',
  bg: 'rgba(177, 78, 18, 0.13)',
  boxShadow: 'inset 0 0 0 1px rgba(177, 78, 18, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
  pointerEvents: 'none',
});

export const timeSliderDim = css({
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  zIndex: 2,
  bg: 'canvas',
  borderRadius: 'full',
  opacity: 0.5,
  pointerEvents: 'none',
});

export const timeSliderDimLeft = cx(timeSliderDim, css({ left: 0, w: 'var(--slider-range-start)' }));
export const timeSliderDimRight = cx(timeSliderDim, css({ right: 0, w: 'var(--slider-range-end)' }));

export const timeSliderBrushRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'max-content minmax(0, 1fr)' },
  gap: '10px',
  alignItems: 'end',
});

export const timeSliderDateInputs = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'end',
});

export const timeSliderBrushColumn = css({
  display: 'grid',
  gap: '6px',
  minW: 0,
});

export const timeSliderBrushHeader = css({
  display: { base: 'grid', sm: 'flex' },
  gridTemplateColumns: '1fr',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '6px 12px',
  color: 'muted',
  fontSize: '11px',
  fontWeight: 600,
});

export const timeSliderQuickRanges = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px',
  justifyContent: { base: 'flex-start', sm: 'flex-end' },
  minW: 0,
});

export const timeSliderBrushTrack = css({
  position: 'relative',
  h: '26px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  overflow: 'visible',
  cursor: 'ew-resize',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.12)',
  _focusWithin: {
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
});

export const monthGridline = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  w: '1px',
  bg: 'line',
  zIndex: 1,
  pointerEvents: 'none',
});

export const timeSliderRangeDrag = css({
  appearance: 'none',
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  left: 'var(--slider-range-start)',
  right: 'var(--slider-range-end)',
  zIndex: 4,
  border: '0',
  p: 0,
  bg: 'transparent',
  cursor: 'grab',
  touchAction: 'none',
  borderRadius: 'full',
  _hover: {
    bg: 'rgba(177, 78, 18, 0.06)',
  },
  '&:hover::before': {
    borderColor: 'accent',
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
    bg: 'rgba(177, 78, 18, 0.1)',
  },
  '&[data-dragging="true"]::before': {
    borderColor: 'accent',
  },
  _before: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '54px',
    h: '16px',
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: 'none',
    opacity: 0.96,
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '14px',
    h: '6px',
    borderLeft: '1px solid token(colors.accent)',
    borderRight: '1px solid token(colors.accent)',
    boxShadow: '5px 0 0 -4px token(colors.accent), -5px 0 0 -4px token(colors.accent)',
  },
});

export const timeSliderThumb = css({
  appearance: 'none',
  position: 'absolute',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 4,
  w: '34px',
  h: '34px',
  border: '0',
  borderRadius: 'full',
  bg: 'transparent',
  cursor: 'ew-resize',
  p: 0,
  touchAction: 'none',
  _before: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '14px',
    h: '26px',
    border: '2px solid token(colors.accent)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: '0 0 0 1px token(colors.canvas)',
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '3px',
    h: '12px',
    borderLeft: '1px solid token(colors.accent)',
    borderRight: '1px solid token(colors.accent)',
    opacity: 0.75,
  },
  _hover: {
    _before: {
      boxShadow: '0 0 0 4px token(colors.focusRing)',
    },
  },
  _focusVisible: {
    outline: '2px solid token(colors.ink)',
    outlineOffset: '-2px',
  },
});

export const timeAxis = css({
  position: 'relative',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'faint',
  fontSize: '11px',
  fontFamily: 'mono',
});

export const timeSliderHandleLabels = css({
  position: 'relative',
  display: { base: 'grid', md: 'block' },
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '8px',
  h: { base: 'auto', md: '28px' },
  mt: '-2px',
});

export const timeSliderHandleLabel = css({
  position: { base: 'static', md: 'absolute' },
  top: 0,
  display: 'grid',
  gap: '2px',
});

export const timeSliderHandleLabelStart = cx(
  timeSliderHandleLabel,
  css({
    left: { base: 'auto', md: 'var(--slider-range-start)' },
    transform: { base: 'none', md: 'translateX(-8px)' },
  }),
);

export const timeSliderHandleLabelEnd = cx(
  timeSliderHandleLabel,
  css({
    left: { base: 'auto', md: 'calc(100% - var(--slider-range-end))' },
    transform: { base: 'none', md: 'translateX(calc(-100% + 8px))' },
  }),
);

export const timeSliderDateChip = css({
  appearance: 'none',
  h: '24px',
  w: { base: '100%', md: '126px' },
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontFamily: 'mono',
  fontSize: '10.5px',
  fontWeight: 650,
  lineHeight: 1,
  outline: 'none',
  boxShadow: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
  _hover: {
    borderColor: 'accent',
    transform: 'translateY(-1px)',
  },
  _focusVisible: {
    borderColor: 'accent',
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
});

export const timeAxisTick = css({
  position: 'absolute',
  display: { base: 'none', sm: 'inline' },
  top: 0,
  transform: 'translateX(-50%)',
  color: 'faint',
  whiteSpace: 'nowrap',
});
