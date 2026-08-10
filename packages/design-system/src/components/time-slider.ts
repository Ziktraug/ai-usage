import { css, cx } from '@ai-usage/design-system/css';

// Keeps the mobile chart-options control at the frozen two-row touch-target height.
const MOBILE_CHART_OPTIONS_SUMMARY_MIN_HEIGHT = '73px';

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
  color: 'muted',
  fontSize: '9px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  lineHeight: 1,
  px: '3px',
  textTransform: 'uppercase',
});

export const timeRangeViewControls = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
  gap: '8px',
  alignItems: 'end',
  justifyContent: 'flex-start',
  p: '10px',
  borderTop: '1px solid token(colors.line)',
});

export const timeChartOptions = css({
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  overflow: 'hidden',
  '&[open] > summary::before': {
    transform: 'rotate(90deg)',
  },
});

export const timeChartOptionsSummary = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  alignContent: { base: 'flex-end', sm: 'stretch' },
  justifyContent: 'flex-start',
  gap: '4px 12px',
  minH: { base: MOBILE_CHART_OPTIONS_SUMMARY_MIN_HEIGHT, sm: 'auto' },
  px: { base: '4px', sm: '10px' },
  pt: { base: '13px', sm: '9px' },
  pb: { base: '5px', sm: '9px' },
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 650,
  listStyle: 'none',
  _focusVisible: {
    outline: '2px solid token(colors.ink)',
    outlineOffset: '-2px',
  },
  '&::-webkit-details-marker': {
    display: 'none',
  },
  _before: {
    content: '"›"',
    color: 'accent',
    fontSize: '16px',
    lineHeight: 1,
    transition: 'transform 0.15s',
  },
});

export const timeChartOptionsTitle = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '7px',
});

export const timeChartOptionsCurrent = css({
  minW: { base: 'max-content', sm: 'auto' },
  color: 'muted',
  fontSize: '11px',
  fontWeight: 600,
  marginInlineStart: 'auto',
  whiteSpace: { base: 'nowrap', sm: 'normal' },
  '@media screen and (max-width: 359px)': { minW: 0, whiteSpace: 'normal' },
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
  _focus: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  '&[data-zoomed="true"]': {
    cursor: 'grab',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
  },
});

export const timeSliderRange = css({
  position: 'absolute',
  top: '4px',
  bottom: '4px',
  zIndex: 3,
  borderRadius: 'full',
  bg: 'interaction.brush',
  boxShadow: 'inset 0 0 0 1px token(colors.focusRing), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
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

export const timeSliderBrushColumn = css({
  display: 'grid',
  gap: '6px',
  minW: 0,
  // The handles are centred on their position, so half of their 44px target sits outside the track.
  // This gutter keeps that half inside the panel instead of letting the end handle lose it.
  px: '22px',
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
    bg: 'interaction.brushHover',
  },
  '&:hover::before': {
    borderColor: 'accent',
    boxShadow: '0 0 0 3px token(colors.focusRing)',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
    bg: 'interaction.brush',
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
  w: '44px',
  h: '44px',
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
