import { describe, expect, test } from 'bun:test';
import { aiUsagePreset } from './preset';

const NORMAL_TEXT_CONTRAST = 4.5;
const UI_COMPONENT_CONTRAST = 3;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
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
