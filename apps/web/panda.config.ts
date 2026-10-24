import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,svelte}'],
  exclude: [],
  outdir: 'styled-system',
  // `panda lib` publishes the design system's theme (its presets and aiUsagePreset), import map
  // and extracted styles; `designSystem` loads all three, so none of them is wired here by hand.
  designSystem: '@ai-usage/design-system',
});
