import { aiUsagePreset } from '@ai-usage/design-system/preset';
import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}', '../../packages/design-system/src/**/*.{ts,tsx}'],
  exclude: [],
  jsxFramework: 'solid',
  outdir: 'styled-system',
  importMap: '@ai-usage/design-system',
  // '@pandacss/preset-panda' restores the default theme (colors, spacing,
  // shadows…) that specifying `presets` would otherwise drop; aiUsagePreset
  // layers our design tokens, conditions, and globalCss on top via `extend`.
  presets: ['@pandacss/preset-panda', aiUsagePreset],
});
