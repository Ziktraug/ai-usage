import { defineConfig } from '@playwright/test';
import production from './playwright.production.config';

/** Explicitly invoked live-metadata profile; protocol guard forbids thread/turn creation. */
export default defineConfig({
  ...production,
  testIgnore: [],
  testMatch: 'work-codex-native.spec.ts',
  use: { ...production.use, baseURL: 'http://127.0.0.1:43188', viewport: { width: 1440, height: 1000 } },
  webServer: {
    ...production.webServer,
    command:
      'AI_USAGE_PRODUCTION_E2E_PORT=43188 AI_USAGE_WORK_ATTEMPT_E2E=1 AI_USAGE_CODEX_NATIVE_REFUSAL=1 bun e2e/production-server.ts',
    reuseExistingServer: false,
    timeout: 60_000,
    url: 'http://127.0.0.1:43188',
  },
});
