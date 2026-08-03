import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

const requiredTemporaryPath = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`The V5 loopback fixture requires ${name}.`);
  }
  return value;
};

export default defineConfig({
  cacheDir: requiredTemporaryPath('AI_USAGE_RPC_LOOPBACK_CACHE_DIR'),
  logLevel: 'silent',
  plugins: [
    nitro({
      buildDir: requiredTemporaryPath('AI_USAGE_RPC_LOOPBACK_BUILD_DIR'),
      handlers: [
        {
          handler: './server/routes/rpc.ts',
          route: '/rpc/**',
        },
      ],
      output: {
        dir: requiredTemporaryPath('AI_USAGE_RPC_LOOPBACK_OUTPUT_DIR'),
      },
      preset: 'bun',
    }),
  ],
  server: {
    allowedHosts: true,
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
});
