import { describe, expect, test } from 'bun:test';
import { PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX } from './components/overview';
import { aiUsagePreset } from './preset';

const NORMAL_TEXT_CONTRAST = 4.5;
const UI_COMPONENT_CONTRAST = 3;
const WCAG_MINIMUM_TARGET_SIZE_PX = 24;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const RGBA_COLOR_PATTERN = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0?\.\d+\)$/;
const RGB_CHANNEL_MAX = 255;
const SRGB_LINEAR_THRESHOLD = 0.040_45;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_EXPONENT = 2.4;
const RED_LUMINANCE_WEIGHT = 0.2126;
const GREEN_LUMINANCE_WEIGHT = 0.7152;
const BLUE_LUMINANCE_WEIGHT = 0.0722;
const CONTRAST_LUMINANCE_OFFSET = 0.05;

type ColorScheme = '_dark' | '_light';

const semanticColors = aiUsagePreset.theme?.extend?.semanticTokens?.colors as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const colorFor = (path: string, scheme: ColorScheme): string => {
  let node = semanticColors;
  for (const segment of path.split('.')) {
    if (!isRecord(node)) {
      throw new Error(`Semantic color ${path} does not exist.`);
    }
    node = node[segment];
  }
  if (!(isRecord(node) && isRecord(node.value) && typeof node.value[scheme] === 'string')) {
    throw new Error(`Semantic color ${path} has no ${scheme} value.`);
  }
  return node.value[scheme];
};

const relativeLuminance = (hexColor: string): number => {
  if (!HEX_COLOR_PATTERN.test(hexColor)) {
    throw new Error(`Expected a six-digit hex color, received ${hexColor}.`);
  }
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hexColor.slice(offset, offset + 2), 16) / RGB_CHANNEL_MAX);
  const linear = channels.map((channel) =>
    channel <= SRGB_LINEAR_THRESHOLD
      ? channel / SRGB_LINEAR_DIVISOR
      : ((channel + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_EXPONENT,
  );
  return (
    RED_LUMINANCE_WEIGHT * (linear[0] ?? 0) +
    GREEN_LUMINANCE_WEIGHT * (linear[1] ?? 0) +
    BLUE_LUMINANCE_WEIGHT * (linear[2] ?? 0)
  );
};

const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + CONTRAST_LUMINANCE_OFFSET) / (darker + CONTRAST_LUMINANCE_OFFSET);
};

const normalTextPairs = [
  ...['muted', 'faint'].flatMap((foreground) =>
    ['canvas', 'surface', 'surfaceMuted'].map((background) => ({ background, foreground })),
  ),
  { background: 'accentTint', foreground: 'faint' },
  ...['canvas', 'surface', 'surfaceMuted', 'accentSoft', 'accentTint'].map((background) => ({
    background,
    foreground: 'accent',
  })),
  ...(['ok', 'warn', 'danger'] as const).flatMap((tone) => [
    { background: 'canvas', foreground: `status.${tone}` },
    { background: 'surface', foreground: `status.${tone}` },
    { background: `status.${tone}Soft`, foreground: `status.${tone}` },
  ]),
  ...(['claude', 'codex', 'cursor', 'opencode', 'gemini'] as const).map((harness) => ({
    background: `harness.${harness}.bg`,
    foreground: `harness.${harness}.fg`,
  })),
  { background: 'canvas', foreground: 'harness.claude.fg' },
  { background: 'surfaceMuted', foreground: 'harness.claude.fg' },
];

describe('semantic color contrast', () => {
  for (const scheme of ['_light', '_dark'] as const) {
    test(`${scheme.slice(1)} normal-text pairs meet WCAG AA`, () => {
      for (const pair of normalTextPairs) {
        const ratio = contrastRatio(colorFor(pair.foreground, scheme), colorFor(pair.background, scheme));
        expect(ratio, `${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(NORMAL_TEXT_CONTRAST);
      }
    });

    test(`${scheme.slice(1)} control boundaries meet non-text contrast`, () => {
      for (const background of ['canvas', 'surface', 'surfaceMuted']) {
        const ratio = contrastRatio(colorFor('lineStrong', scheme), colorFor(background, scheme));
        expect(ratio, `lineStrong on ${background}`).toBeGreaterThanOrEqual(UI_COMPONENT_CONTRAST);
      }
    });
  }
});

describe('semantic palette roles', () => {
  for (const scheme of ['_light', '_dark'] as const) {
    test(`${scheme.slice(1)} separates interaction, categorical, and default-control colors`, () => {
      const accent = colorFor('accent', scheme);
      const chartPrimary = colorFor('chart.c1', scheme);
      const claude = colorFor('harness.claude.fg', scheme);
      const controlDefault = colorFor('controlDefault', scheme);
      const brush = colorFor('interaction.brush', scheme);
      const brushHover = colorFor('interaction.brushHover', scheme);
      const warning = colorFor('status.warn', scheme);

      expect(chartPrimary).not.toBe(accent);
      expect(claude).not.toBe(accent);
      expect(claude).not.toBe(chartPrimary);
      expect(controlDefault).toBe(colorFor('surfaceMuted', scheme));
      expect(controlDefault).not.toBe(accent);
      expect(warning).not.toBe(accent);
      expect(warning).not.toBe(chartPrimary);
      expect(brush).toMatch(RGBA_COLOR_PATTERN);
      expect(brushHover).toMatch(RGBA_COLOR_PATTERN);
      expect(brushHover).not.toBe(brush);
    });
  }

  test('the activity brush has explicit light and dark interaction colors', () => {
    expect(colorFor('interaction.brush', '_light')).not.toBe(colorFor('interaction.brush', '_dark'));
    expect(colorFor('interaction.brushHover', '_light')).not.toBe(colorFor('interaction.brushHover', '_dark'));
  });
});

describe('provider brand marks', () => {
  for (const scheme of ['_light', '_dark'] as const) {
    test(`${scheme.slice(1)} carries a brand color only for providers that publish one`, () => {
      // Cursor and OpenCode publish monochrome marks, so they deliberately have no brand entry and
      // fall back to the curated categorical hue. Adding one would be inventing a brand identity.
      const brand = aiUsagePreset.theme?.extend?.semanticTokens?.colors?.brand as Record<string, unknown>;

      expect(Object.keys(brand).toSorted()).toEqual(['claude', 'codex']);
      expect(colorFor('brand.claude', scheme)).not.toBe(colorFor('harness.claude.fg', scheme));
      expect(colorFor('brand.codex', scheme)).not.toBe(colorFor('harness.codex.fg', scheme));
    });
  }
});

test('preset preserves the exact global CSS, keyframes, tokens, and semantic values', () => {
  const presetHash = new Bun.CryptoHasher('sha256').update(JSON.stringify(aiUsagePreset)).digest('hex');
  expect(presetHash).toBe('f4ea6ba5b77516c81b7ba1a950a36135b54e80ebc43b0a52055795c27b13b15d');
});

test('punchcard controls meet the minimum interactive target size', () => {
  expect(PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX).toBeGreaterThanOrEqual(WCAG_MINIMUM_TARGET_SIZE_PX);
});
