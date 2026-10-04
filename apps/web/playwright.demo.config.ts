import { defineConfig, devices } from '@playwright/test';

/**
 * A cold Bun/Vite start can stall when HTTP readiness probes arrive before Vite has
 * finished initializing. Wait for its strict loopback listener announcement instead;
 * the browser suite then verifies the real HTTP response. Do not combine this with a
 * webServer URL: Playwright races output and HTTP readiness instead of sequencing them.
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
    stdout: 'pipe',
    timeout: WEB_SERVER_COLD_START_TIMEOUT_MS,
    wait: { stdout: /Local:\s+http:\/\/127\.0\.0\.1:4176\// },
  },
});
