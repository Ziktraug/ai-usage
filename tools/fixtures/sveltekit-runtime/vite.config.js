import { sveltekit } from '@sveltejs/kit/vite';
import adapter from 'svelte-adapter-bun';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ out: 'build', precompress: false }),
      outDir: '.svelte-kit',
    }),
  ],
});
