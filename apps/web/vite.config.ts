import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { resolveSvelteKitOutputPaths } from './sveltekit-output-paths.ts';
import { webClientModuleManifest } from './vite-client-module-manifest.ts';

const LOOPBACK_HOST = '127.0.0.1' as const;
const DEFAULT_DEVELOPMENT_PORT = '5173';

export interface ViteDevelopmentServerBinding {
  readonly host: typeof LOOPBACK_HOST;
  readonly port?: number;
  readonly strictPort?: boolean;
}

export const resolveViteDevelopmentServerBinding = (
  command: 'build' | 'serve',
  requestedPort: string | undefined,
): ViteDevelopmentServerBinding => {
  if (command !== 'serve') {
    return { host: LOOPBACK_HOST };
  }
  const portValue = requestedPort ?? DEFAULT_DEVELOPMENT_PORT;
  const port = Number(portValue);
  if (!(Number.isSafeInteger(port) && port > 0 && port <= 65_535 && String(port) === portValue)) {
    throw new Error('PORT must be a canonical integer between 1 and 65535.');
  }
  return { host: LOOPBACK_HOST, port, strictPort: true };
};

const { intermediateDirectory, viteCacheDirectory } = resolveSvelteKitOutputPaths();

export default defineConfig(({ command }) => ({
  cacheDir: viteCacheDirectory,
  plugins: [
    sveltekit(),
    webClientModuleManifest({
      manifestFile: `${intermediateDirectory}/private/client-modules.json`,
    }),
  ],
  server: {
    ...resolveViteDevelopmentServerBinding(command, process.env.PORT),
    watch: {
      ignored: ['**/.output-build/**', '**/.svelte-kit/**', '**/dist/**', '**/styled-system/**'],
    },
  },
}));
