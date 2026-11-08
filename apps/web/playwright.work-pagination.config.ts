import { defineConfig } from '@playwright/test';
import browser from './playwright.config';

const PORT = 4179;

/** Pagination journeys create more tasks than a page holds; a separate dev server keeps that state apart. */
export default defineConfig({
  ...browser,
  testIgnore: [],
  testMatch: 'work-pagination.spec.ts',
  use: { ...browser.use, baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    ...browser.webServer,
    command: `AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES=1 BROWSER=none TZ=UTC VITE_AI_USAGE_E2E=1 bun run dev -- --port ${PORT} --strictPort`,
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${PORT}/`) },
  },
});
