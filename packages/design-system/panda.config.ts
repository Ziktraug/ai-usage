import { defineConfig } from '@pandacss/dev';
import { aiUsagePreset } from './src/preset';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,svelte}'],
  exclude: [],
  outdir: 'styled-system',
  importMap: '@ai-usage/design-system',
  // Panda 2 applies no preset implicitly: '@pandacss/preset-base' (utilities, conditions) and
  // '@pandacss/preset-panda' (the default theme) come first, and aiUsagePreset layers our design
  // tokens, conditions and globalCss on top via `extend`. `panda lib` publishes this list to apps/web.
  presets: ['@pandacss/preset-base', '@pandacss/preset-panda', aiUsagePreset],
});
