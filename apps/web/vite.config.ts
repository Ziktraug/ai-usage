import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';

const solidDepScanPlugin = (): Plugin => ({
  name: 'ai-usage-solid-dep-scan',
  enforce: 'post',
  configEnvironment: {
    order: 'post',
    handler(_name, config) {
      config.optimizeDeps ??= {};
      config.optimizeDeps.rolldownOptions ??= {};
      config.optimizeDeps.rolldownOptions.transform ??= {};
      config.optimizeDeps.rolldownOptions.transform.jsx = 'preserve';
    },
  },
});

export default defineConfig({
  plugins: [
    tanstackStart({
      router: {
        codeSplittingOptions: {
          defaultBehavior: [],
        },
      },
    }),
    solid({ ssr: true }),
    nitro(),
    solidDepScanPlugin(),
  ],
  build: {
    cssCodeSplit: false,
  },
  server: {
    watch: {
      // The design-system package writes Panda helpers in-place during check/build.
      // If a dev server watches those generated files, HMR can import them mid-write
      // and leave the client bundle unhydrated until a full restart.
      ignored: ['**/packages/design-system/styled-system/**'],
    },
  },
  resolve: {
    dedupe: ['solid-js', 'solid-js/web'],
  },
});
