import { css } from '@ai-usage/design-system/css';
import { harnessFillFor } from '../svelte/passive/harness-fill';

export { harnessMarkFillFor } from '../svelte/passive/harness-fill';

/** Ranked fills; adjacent slots are the pairs that can touch in the stack. */
export const rankedSeriesSwatchClasses = [
  css({ bg: 'chart.c3' }),
  css({ bg: 'chart.c2' }),
  css({ bg: 'chart.c7' }),
  css({ bg: 'chart.c13' }),
  css({ bg: 'chart.c12' }),
  css({ bg: 'chart.c11' }),
  css({ bg: 'chart.c5' }),
  css({ bg: 'chart.c8' }),
  css({ bg: 'chart.c1' }),
  css({ bg: 'chart.c6' }),
  css({ bg: 'chart.c9' }),
  css({ bg: 'chart.c10' }),
] as const;

export const RANKED_SERIES_HEX = [
  ['#6A47C8', '#AC92F2'],
  ['#0E7569', '#46C3AC'],
  ['#588BE0', '#5590F3'],
  ['#B8527E', '#FC90BC'],
  ['#0A6B1D', '#61B565'],
  ['#853376', '#D37BC1'],
  ['#647722', '#A9BB5E'],
  ['#3B4FA5', '#A7B5FE'],
  ['#9B4210', '#F19A57'],
  ['#0F6FA8', '#5FB5E2'],
  ['#9B7300', '#C69612'],
  ['#9250A0', '#DF99EF'],
] as const;
export const RANKED_SERIES_SLOT_COUNT = RANKED_SERIES_HEX.length;

/** Aggregated tails are context, not another ranked series. */
export const aggregateSeriesFill = css({ bg: 'lineStrong' });

const stableHueFor = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
};

export const stableSeriesColor = (value: string) => `hsl(${stableHueFor(value)} 42% 60%)`;

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
  position: { readonly aggregate?: boolean; readonly rank?: number } = {},
): DimensionSwatch => {
  if (position.aggregate === true) {
    return { className: aggregateSeriesFill };
  }
  // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
  switch (dimension) {
    case 'harness': {
      const className = harnessFillFor(key);
      return className ? { className } : {};
    }
    case 'model': {
      const className =
        position.rank === undefined || position.rank >= RANKED_SERIES_SLOT_COUNT
          ? undefined
          : rankedSeriesSwatchClasses[position.rank];
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
