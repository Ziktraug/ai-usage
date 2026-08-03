import { defineConfig } from '@pandacss/dev';
import { aiUsagePreset } from './src/preset';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,svelte}'],
  exclude: [],
  outdir: 'styled-system',
  importMap: '@ai-usage/design-system',
  presets: ['@pandacss/preset-panda', aiUsagePreset],
});
