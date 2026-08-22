import { defineConfig, devices } from '@playwright/test';

/**
 * This is not a boot budget. Playwright waits for the first successful response, and reaching it
 * means Vite has optimised the dependency graph and transformed the app for SSR -- work whose scale
 * is a build, not a process start, and which a fresh checkout always pays in full.
 *
 * Measured on the development machine after `dev:prepare`: Vite reports ready in 816ms, but the
 * first response lands at 4,382ms, so the transform dominates. CI runs on two cores with the other
 * jobs alongside, and 120s was not enough there twice: both failures were "never became ready",
 * never a server that answered and then misbehaved.
 *
 * Sized so a runner an order of magnitude slower than the development machine still starts. A server
 * that is genuinely broken fails immediately with its own error rather than by waiting this out.
 */
const WEB_SERVER_COLD_START_TIMEOUT_MS = 300_000;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun e2e/production-server.ts',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: WEB_SERVER_COLD_START_TIMEOUT_MS,
    url: 'http://127.0.0.1:4175',
  },
});
