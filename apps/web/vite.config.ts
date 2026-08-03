import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolveSvelteKitOutputPaths } from './sveltekit-output-paths.ts';

const { viteCacheDirectory } = resolveSvelteKitOutputPaths();

export default defineConfig({
  cacheDir: viteCacheDirectory,
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: ['**/.output-build/**', '**/.output-dev/**', '**/.svelte-kit/**', '**/dist/**', '**/styled-system/**'],
    },
  },
});
