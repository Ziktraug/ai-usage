import { css } from '@ai-usage/design-system/css';
import { harnessFillFor } from './badge';

export const chartAxis = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'muted',
  fontSize: '11px',
  fontFamily: 'mono',
});

export const chartLegendList = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 14px',
  color: 'muted',
  fontSize: '11px',
});

export const chartLegendItem = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
});

export const chartLegendSwatch = css({
  w: '8px',
  h: '8px',
  borderRadius: '2px',
  flexShrink: 0,
});

export const chartLegendPct = css({
  textStyle: 'numeric',
  color: 'muted',
});

export const chartSwatchClasses = [
  css({ bg: 'chart.c1' }),
  css({ bg: 'chart.c2' }),
  css({ bg: 'chart.c3' }),
  css({ bg: 'chart.c4' }),
  css({ bg: 'chart.c5' }),
  css({ bg: 'chart.c6' }),
];

// Keep fallback colors deterministic so a category retains its identity when
// filters or value rankings change.
export const overflowSeriesColor = (index: number) => `hsl(${Math.round((index * 137.508) % 360)} 42% 60%)`;

const stableHueFor = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
};

export const stableSeriesColor = (value: string) => `hsl(${stableHueFor(value)} 42% 60%)`;

export const stableSeriesIndex = (value: string, itemCount: number) =>
  itemCount > 0 ? stableHueFor(value) % itemCount : 0;

export interface DimensionSwatch {
  className?: string;
  style?: { background: string };
}

export const dimensionSwatch = (
  dimension: 'harness' | 'model' | 'project' | 'provider',
  key: string,
): DimensionSwatch => {
  if (dimension === 'harness') {
    const className = harnessFillFor(key);
    return className ? { className } : {};
  }
  const className =
    dimension === 'model' ? chartSwatchClasses[stableSeriesIndex(key, chartSwatchClasses.length)] : undefined;
  if (className) {
    return { className };
  }
  return { style: { background: stableSeriesColor(key) } };
};

export const scatterGridline = css({
  stroke: 'token(colors.line)',
  strokeWidth: '1',
});

export const scatterAxisText = css({
  fill: 'token(colors.muted)',
  fontSize: '10px',
  fontFamily: 'mono',
});

export const scatterPoint = css({
  fillOpacity: 0.7,
  transition: 'fill-opacity 0.1s',
});

export const scatterLegend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

export const scatterSummary = css({
  color: 'muted',
  fontFamily: 'mono',
  fontSize: '10px',
});

export const scatterDistribution = css({
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '11px',
  '& summary': {
    display: 'flex',
    alignItems: 'center',
    minH: '44px',
    px: '10px',
    color: 'ink',
    cursor: 'pointer',
    fontWeight: 650,
  },
  '& summary:focus-visible': {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const scatterDistributionList = css({
  display: 'grid',
  gap: '6px',
  m: 0,
  p: '0 10px 10px',
  listStyle: 'none',
});

export const scatterDistributionRow = css({
  display: 'grid',
  gap: '3px',
  p: '8px',
  borderRadius: 'sm',
  bg: 'surface',
});

export const scatterDistributionMeta = css({
  textStyle: 'numeric',
  color: 'muted',
  fontSize: '10px',
});

export const scatterOutliers = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
  gap: '6px',
});

export const scatterOutlierButton = css({
  appearance: 'none',
  display: 'grid',
  gap: '3px',
  minW: 0,
  minH: '44px',
  p: '8px 10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 650,
  textAlign: 'left',
  transition: 'border-color 0.15s, background-color 0.15s',
  '& > span:first-child': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  _hover: {
    borderColor: 'accent',
    bg: 'accentTint',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const scatterOutlierMeta = css({
  textStyle: 'numeric',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// --- Model migration histogram -------------------------------------------
// A dense stacked-bar histogram (one bar per daily/weekly bucket) with a rich
// crosshair tooltip. SVG is avoided on purpose: DOM bars make per-bar hover
// trivial, and the axis/markers/tooltip overlay as plain HTML so nothing ever
// stretches.

export const migrationToolbar = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '10px 14px',
  mb: '12px',
});

export const migrationToolbarSpacer = css({ marginInlineStart: 'auto' });

export const migrationTotal = css({
  textStyle: 'numeric',
  fontSize: '13px',
  fontWeight: 650,
  color: 'ink',
});

export const migrationPlot = css({
  position: 'relative',
  h: '210px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

export const migrationGrid = css({ position: 'absolute', inset: 0, pointerEvents: 'none' });

export const migrationGridLine = css({
  position: 'absolute',
  left: 0,
  right: 0,
  borderTop: '1px solid token(colors.line)',
});

export const migrationGridLabel = css({
  position: 'absolute',
  right: '4px',
  top: '2px',
  textStyle: 'numeric',
  fontSize: '10px',
  color: 'muted',
  bg: 'surfaceMuted',
  px: '4px',
});

export const migrationBars = css({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'flex-end',
  gap: '1.5px',
  px: '2px',
});

export const migrationBar = css({
  position: 'relative',
  flex: '1 1 0',
  minW: 0,
  display: 'flex',
  flexDirection: 'column-reverse',
  borderRadius: '3px 3px 0 0',
  overflow: 'hidden',
});

export const migrationSeg = css({
  w: '100%',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  transition: 'opacity 0.12s',
});

// A hairline marking the hovered bucket, so the below-plot readout has an
// obvious anchor without covering the bars.
export const migrationCrosshair = css({
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 0,
  borderLeft: '1px solid token(colors.lineStrong)',
  pointerEvents: 'none',
});

// Hover readout — lives below the plot (not over the bars) so it never hides
// what you're inspecting. Reserves a fixed band to avoid layout jump.
export const migrationReadout = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  alignContent: 'flex-start',
  gap: '5px 12px',
  mt: '12px',
  p: '8px 10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  minH: '40px',
  fontSize: '11.5px',
});

export const migrationReadoutDate = css({ textStyle: 'numeric', fontWeight: 600, color: 'ink' });
export const migrationReadoutTotal = css({ textStyle: 'numeric', color: 'muted', mr: '4px' });
export const migrationReadoutHint = css({ color: 'muted' });

export const migrationReadoutItem = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
  color: 'muted',
});

export const migrationReadoutItemActive = css({ color: 'ink', fontWeight: 650 });
export const migrationReadoutSwatch = css({ w: '9px', h: '9px', borderRadius: '2px', flexShrink: 0 });
export const migrationReadoutValue = css({ textStyle: 'numeric', color: 'muted', whiteSpace: 'nowrap' });

export const migrationLegendMore = css({
  appearance: 'none',
  bg: 'transparent',
  border: 0,
  p: 0,
  cursor: 'pointer',
  fontSize: '11px',
  fontWeight: 600,
  color: 'accent',
  _hover: { textDecoration: 'underline' },
  _focusVisible: {
    outline: '1px solid token(colors.accent)',
    outlineOffset: '2px',
    borderRadius: '2px',
  },
});

export const migrationXAxis = css({ position: 'relative', h: '14px', mt: '8px' });

export const migrationXTick = css({
  position: 'absolute',
  transform: 'translateX(-50%)',
  textStyle: 'numeric',
  fontSize: '10px',
  color: 'muted',
  fontWeight: 600,
  whiteSpace: 'nowrap',
});

export const migrationLegendButton = css({
  appearance: 'none',
  bg: 'transparent',
  border: 0,
  p: 0,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
  color: 'muted',
  fontSize: '11px',
  _hover: { color: 'ink' },
  _focusVisible: {
    outline: '1px solid token(colors.accent)',
    outlineOffset: '2px',
    borderRadius: '2px',
  },
});

export const migrationTrend = css({ textStyle: 'numeric', fontSize: '10px' });
export const migrationTrendUp = css({ color: 'chart.c2' });
export const migrationTrendDown = css({ color: 'accent' });

export const highlightMark = css({
  bg: 'accentSoft',
  color: 'inherit',
  borderRadius: '2px',
});

export const sortArrow = css({
  color: 'accent',
  fontSize: '10px',
  lineHeight: '1',
});
