import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolveSvelteShadowOutputPaths } from './vite-svelte-shadow-output.ts';

const { viteCacheDirectory } = resolveSvelteShadowOutputPaths();

export default defineConfig({
  cacheDir: viteCacheDirectory,
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: [
        '**/.output-build/**',
        '**/.output-dev/**',
        '**/.svelte-kit-shadow/**',
        '**/dist/**',
        '**/styled-system/**',
      ],
    },
  },
});
