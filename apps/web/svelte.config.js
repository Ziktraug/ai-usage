import adapter from 'svelte-adapter-bun';
import { resolveSvelteKitOutputPaths, resolveSvelteKitVersionName } from './sveltekit-output-paths.ts';

const { adapterDirectory, intermediateDirectory } = resolveSvelteKitOutputPaths();
const versionName = resolveSvelteKitVersionName();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    env: { privatePrefix: 'AI_USAGE_SVELTEKIT_PRIVATE_' },
    adapter: adapter({ out: adapterDirectory, precompress: false }),
    outDir: intermediateDirectory,
    version: { name: versionName },
  },
};

export default config;
