import { describe, expect, test } from 'bun:test';
import {
  aggregateSeriesFill,
  dimensionSwatch,
  RANKED_SERIES_HEX,
  RANKED_SERIES_SLOT_COUNT,
  rankedSeriesSwatchClasses,
  stableSeriesColor,
} from './chart';

type ColorVector = readonly [number, number, number];
const HSL_COLOR_PATTERN = /^hsl\(\d+ 42% 60%\)$/;

const channel = (hex: string, offset: number): number => {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const linearRgb = (hex: string): ColorVector => [channel(hex, 1), channel(hex, 3), channel(hex, 5)];

const oklab = ([red, green, blue]: ColorVector): ColorVector => {
  const long = Math.cbrt(0.412_221_470_8 * red + 0.536_332_536_3 * green + 0.051_445_992_9 * blue);
  const medium = Math.cbrt(0.211_903_498_2 * red + 0.680_699_545_1 * green + 0.107_396_956_6 * blue);
  const short = Math.cbrt(0.088_302_461_9 * red + 0.281_718_837_6 * green + 0.629_978_700_5 * blue);
  return [
    0.210_454_255_3 * long + 0.793_617_785 * medium - 0.004_072_046_8 * short,
    1.977_998_495_1 * long - 2.428_592_205 * medium + 0.450_593_709_9 * short,
    0.025_904_037_1 * long + 0.782_771_766_2 * medium - 0.808_675_766 * short,
  ];
};

const distance = (left: string, right: string): number => {
  const first = oklab(linearRgb(left));
  const second = oklab(linearRgb(right));
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]) * 100;
};

const luminance = (hex: string): number => {
  const [red, green, blue] = linearRgb(hex);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

const contrast = (foreground: string, background: string): number => {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};

describe('categorical chart colors', () => {
  test('derives literal colors from the series key', () => {
    expect(stableSeriesColor('gpt-5')).toMatch(HSL_COLOR_PATTERN);
    expect(stableSeriesColor('gpt-5')).toBe(stableSeriesColor('gpt-5'));
  });

  test('assigns twelve model slots by rank and keeps aggregates neutral', () => {
    expect(RANKED_SERIES_SLOT_COUNT).toBe(12);
    expect(new Set(rankedSeriesSwatchClasses).size).toBe(12);
    expect(dimensionSwatch('model', 'same-key', { rank: 0 })).not.toEqual(
      dimensionSwatch('model', 'same-key', { rank: 1 }),
    );
    expect(dimensionSwatch('model', 'same-key')).toEqual({});
    expect(dimensionSwatch('model', 'tail', { aggregate: true, rank: 11 })).toEqual({
      className: aggregateSeriesFill,
    });
    expect(dimensionSwatch('project', 'tail', { aggregate: true })).toEqual({ className: aggregateSeriesFill });
  });

  for (const [schemeIndex, schemeName, background] of [
    [0, 'light', '#FFFFFF'],
    [1, 'dark', '#18191C'],
  ] as const) {
    test(`${schemeName} ranked palette keeps the measured distance and contrast floors`, () => {
      const palette = RANKED_SERIES_HEX.map((pair) => pair[schemeIndex]);
      expect(new Set(palette).size).toBe(12);
      for (const [index, current] of palette.entries()) {
        expect(contrast(current, background), `slot ${index + 1}`).toBeGreaterThanOrEqual(3);
        for (let nextIndex = index + 1; nextIndex < palette.length; nextIndex += 1) {
          const next = palette[nextIndex];
          expect(next).toBeDefined();
          const minimum = nextIndex === index + 1 ? 18 : 8;
          expect(
            distance(current, next ?? current),
            `slot ${index + 1} beside ${nextIndex + 1}`,
          ).toBeGreaterThanOrEqual(minimum);
        }
      }
    });
  }
});
