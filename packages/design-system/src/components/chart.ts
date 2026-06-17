import { css } from '@ai-usage/design-system/css';

export const chartAxis = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'faint',
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
  color: 'faint',
});

export const chartFillClasses = [
  css({ fill: 'chart.c1' }),
  css({ fill: 'chart.c2' }),
  css({ fill: 'chart.c3' }),
  css({ fill: 'chart.c4' }),
  css({ fill: 'chart.c5' }),
];

export const chartSwatchClasses = [
  css({ bg: 'chart.c1' }),
  css({ bg: 'chart.c2' }),
  css({ bg: 'chart.c3' }),
  css({ bg: 'chart.c4' }),
  css({ bg: 'chart.c5' }),
];

export const otherFillClass = css({ fill: 'lineStrong' });
export const otherSwatchClass = css({ bg: 'lineStrong' });

export const scatterGridline = css({
  stroke: 'token(colors.line)',
  strokeWidth: '1',
});

export const scatterAxisText = css({
  fill: 'token(colors.faint)',
  fontSize: '10px',
  fontFamily: 'mono',
});

export const scatterPoint = css({
  fillOpacity: 0.7,
  cursor: 'pointer',
  transition: 'fill-opacity 0.1s',
  _hover: {
    fillOpacity: 1,
  },
});

export const scatterLegend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
});

export const migrationArea = css({
  opacity: 0.88,
  transition: 'opacity 0.15s',
  _hover: { opacity: 1 },
});

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
