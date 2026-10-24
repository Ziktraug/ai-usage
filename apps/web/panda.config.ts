import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,svelte}'],
  exclude: [],
  outdir: 'styled-system',
  // `panda lib` publishes the design system's theme (its presets and aiUsagePreset), import map
  // and extracted styles; `designSystem` loads all three, so none of them is wired here by hand.
  designSystem: '@ai-usage/design-system',
  // Set here, not in the design system: this is the stylesheet the app serves, and its extraction
  // covers the app sources plus the design system's published styles, so only here is "unused"
  // known. bundle/client-bundle.test.ts checks the served stylesheet declares exactly the tokens
  // and keyframes it references; no runtime code reads a token variable by name.
  optimize: {
    removeUnusedTokens: true,
    removeUnusedKeyframes: true,
  },
});
