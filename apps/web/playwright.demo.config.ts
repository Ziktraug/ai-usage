import { defineConfig, devices } from '@playwright/test';

/**
 * This server is `bun --bun vite` in demo mode, not a built artifact, so it shares the dev
 * server's startup profile and its known startup-hang class. Measured on the 2026-08-25 green CI
 * run: ~6s from the SvelteKit tsconfig warning to tests running. 20s is ~3x headroom; a miss is a
 * hang, not a slow start, and a larger number only buys a slower red.
 */
const WEB_SERVER_COLD_START_TIMEOUT_MS = 20_000;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: 'demo-isolation.spec.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4176',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun --no-env-file ../../tools/run-web-demo.ts --serve-only',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    reuseExistingServer: false,
    timeout: WEB_SERVER_COLD_START_TIMEOUT_MS,
    url: 'http://127.0.0.1:4176',
  },
});
