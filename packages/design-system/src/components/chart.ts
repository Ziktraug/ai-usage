import { css } from '@ai-usage/design-system/css';
import { harnessFillFor } from '../svelte/passive/harness-fill';

export const chartSwatchClasses = [
  css({ bg: 'chart.c1' }),
  css({ bg: 'chart.c2' }),
  css({ bg: 'chart.c3' }),
  css({ bg: 'chart.c4' }),
  css({ bg: 'chart.c5' }),
  css({ bg: 'chart.c6' }),
];

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

/**
 * Neutral series fill. Callers use it as the sibling fallback when a swatch
 * carries no branded class — never as a base layer under one, because Panda's
 * `cx` only joins class names and two equal-specificity `bg` atoms are resolved
 * by stylesheet order, not attribute order.
 */
export const accentFill = css({ bg: 'accent' });

export interface DimensionSwatch {
  className?: string;
  style?: { background: string };
}

export const dimensionSwatch = (
  dimension: 'campaign' | 'harness' | 'machine' | 'model' | 'origin' | 'project' | 'provider',
  key: string,
): DimensionSwatch => {
  // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
  switch (dimension) {
    case 'harness': {
      const className = harnessFillFor(key);
      return className ? { className } : {};
    }
    case 'model': {
      const className = chartSwatchClasses[stableSeriesIndex(key, chartSwatchClasses.length)];
      return className ? { className } : {};
    }
    case 'campaign':
    case 'machine':
    case 'origin':
    case 'project':
    case 'provider':
      return { style: { background: stableSeriesColor(key) } };
  }
};

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
