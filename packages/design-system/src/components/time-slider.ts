import { css, cx } from '@ai-usage/design-system/css';

export const timeRangePanel = css({
  display: 'grid',
  gap: '14px',
  mt: '14px',
  p: '14px 16px 16px',
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

export const timeRangeHeaderControls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  justifyContent: { base: 'flex-start', md: 'flex-end' },
  minW: 0,
});

export const dateEditRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'end',
});

export const timeSliderRoot = css({
  display: 'grid',
  gap: '8px',
});

export const timeSliderControl = css({
  position: 'relative',
  h: '128px',
});

export const timeSliderTrack = css({
  position: 'relative',
  h: '128px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  overflow: 'hidden',
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.32)',
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
  top: 0,
  bottom: 0,
  zIndex: 3,
  borderLeft: '2px solid token(colors.accent)',
  borderRight: '2px solid token(colors.accent)',
  pointerEvents: 'none',
});

export const timeSliderDim = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 3,
  bg: 'canvas',
  opacity: 0.62,
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

export const timeSliderBrushTrack = css({
  position: 'relative',
  h: '28px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  overflow: 'hidden',
  cursor: 'ew-resize',
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
  top: 0,
  h: '18px',
  left: 'var(--slider-range-start)',
  right: 'var(--slider-range-end)',
  zIndex: 4,
  border: '0',
  p: 0,
  bg: 'transparent',
  cursor: 'grab',
  touchAction: 'none',
  _hover: {
    bg: 'rgba(177, 78, 18, 0.08)',
  },
  '&[data-dragging="true"]': {
    cursor: 'grabbing',
    bg: 'rgba(177, 78, 18, 0.12)',
  },
  _before: {
    content: '""',
    position: 'absolute',
    top: '3px',
    left: '50%',
    transform: 'translateX(-50%)',
    w: '46px',
    h: '14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: 'card',
    opacity: 0.9,
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    w: '20px',
    h: '4px',
    borderTop: '1px solid token(colors.accent)',
    borderBottom: '1px solid token(colors.accent)',
  },
});

export const timeSliderThumb = css({
  appearance: 'none',
  position: 'absolute',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 4,
  w: '28px',
  h: '28px',
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
    h: '24px',
    border: '2px solid token(colors.accent)',
    borderRadius: 'full',
    bg: 'surface',
    boxShadow: 'overlay',
  },
  _after: {
    content: '""',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    w: '4px',
    h: '14px',
    borderLeft: '1px solid token(colors.accent)',
    borderRight: '1px solid token(colors.accent)',
    opacity: 0.75,
  },
  _hover: {
    _before: {
      boxShadow: '0 0 0 4px token(colors.focusRing), token(shadows.overlay)',
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

export const timeAxisTick = css({
  position: 'absolute',
  top: 0,
  transform: 'translateX(-50%)',
  color: 'faint',
  whiteSpace: 'nowrap',
});
