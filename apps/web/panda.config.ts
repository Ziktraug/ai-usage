import { aiUsagePreset } from '@ai-usage/design-system/preset';
import { defineConfig } from '@pandacss/dev';

const designSystemBuildInfoPackage = '@ai-usage/design-system/panda.buildinfo.json';
const designSystemBuildInfo = require.resolve(designSystemBuildInfoPackage);

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}', designSystemBuildInfo],
  exclude: [],
  jsxFramework: 'solid',
  outdir: 'styled-system',
  importMap: '@ai-usage/design-system',
  // '@pandacss/preset-panda' restores the default theme (colors, spacing,
  // shadows…) that specifying `presets` would otherwise drop; aiUsagePreset
  // layers our design tokens, conditions, and globalCss on top via `extend`.
  presets: ['@pandacss/preset-panda', aiUsagePreset],
});
