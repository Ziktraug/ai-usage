import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolveSvelteKitOutputPaths } from './sveltekit-output-paths.ts';
import { webClientModuleManifest } from './vite-client-module-manifest.ts';

const { intermediateDirectory, viteCacheDirectory } = resolveSvelteKitOutputPaths();

export default defineConfig({
  cacheDir: viteCacheDirectory,
  plugins: [
    sveltekit(),
    webClientModuleManifest({
      manifestFile: `${intermediateDirectory}/private/client-modules.json`,
    }),
  ],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: ['**/.output-build/**', '**/.svelte-kit/**', '**/dist/**', '**/styled-system/**'],
    },
  },
});
