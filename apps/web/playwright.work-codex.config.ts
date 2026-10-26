import { defineConfig } from '@playwright/test';
import production from './playwright.production.config';

/** Separate isolated profile: visibly synthetic app-server lifecycle, never a native success claim. */
export default defineConfig({
  ...production,
  testIgnore: [],
  testMatch: 'work-codex-production.spec.ts',
  use: { ...production.use, baseURL: 'http://127.0.0.1:43187', viewport: { width: 1440, height: 1000 } },
  webServer: {
    ...production.webServer,
    command:
      'AI_USAGE_PRODUCTION_E2E_PORT=43187 AI_USAGE_WORK_ATTEMPT_E2E=1 AI_USAGE_CODEX_JOURNEY_E2E=1 bun e2e/production-server.ts',
    reuseExistingServer: false,
    timeout: 60_000,
    url: 'http://127.0.0.1:43187',
  },
});
