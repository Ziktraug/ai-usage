import { defineConfig } from '@pandacss/dev';
import { aiUsagePreset } from './src/preset';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}'],
  exclude: [],
  jsxFramework: 'solid',
  outdir: 'styled-system',
  importMap: '@ai-usage/design-system',
  presets: ['@pandacss/preset-panda', aiUsagePreset],
});
