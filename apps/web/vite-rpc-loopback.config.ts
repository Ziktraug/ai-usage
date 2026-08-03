import { createNitro } from 'nitro/builder';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';

const requiredFixturePath = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`The V5 loopback fixture requires ${name}.`);
  }
  return value;
};

const nitroInstance = await createNitro({
  buildDir: requiredFixturePath('AI_USAGE_RPC_LOOPBACK_BUILD_DIR'),
  builder: 'vite',
  dev: true,
  handlers: [
    {
      handler: './server/routes/rpc.ts',
      route: '/rpc/**',
    },
  ],
  output: {
    dir: requiredFixturePath('AI_USAGE_RPC_LOOPBACK_OUTPUT_DIR'),
  },
  preset: 'bun',
  rootDir: requiredFixturePath('AI_USAGE_RPC_LOOPBACK_WEB_ROOT'),
});
let nitroClosePromise: Promise<void> | undefined;
const closeOwnedNitro = (): Promise<void> => {
  nitroClosePromise ??= nitroInstance.close();
  return nitroClosePromise;
};
const nitroTeardownPlugin: Plugin = {
  name: 'ai-usage:rpc-loopback-nitro-teardown',
  async closeBundle() {
    await closeOwnedNitro();
  },
};

export default defineConfig({
  cacheDir: requiredFixturePath('AI_USAGE_RPC_LOOPBACK_CACHE_DIR'),
  logLevel: 'silent',
  plugins: [nitro({ _nitro: nitroInstance }), nitroTeardownPlugin],
  server: {
    allowedHosts: true,
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
});
