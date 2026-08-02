import adapter from 'svelte-adapter-bun';
import { resolveSvelteShadowOutputPaths } from './vite-svelte-shadow-output.ts';

const { adapterDirectory, intermediateDirectory } = resolveSvelteShadowOutputPaths();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    env: { privatePrefix: 'AI_USAGE_SVELTEKIT_SHADOW_PRIVATE_' },
    adapter: adapter({ out: adapterDirectory, precompress: false }),
    files: {
      src: 'svelte-shadow',
      appTemplate: 'svelte-shadow/app.html',
      assets: 'public',
      hooks: {
        server: 'svelte-shadow/hooks.server.ts',
      },
      lib: 'src/lib',
      routes: 'svelte-shadow/routes',
    },
    outDir: intermediateDirectory,
  },
};

export default config;
