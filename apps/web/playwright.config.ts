import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testIgnore: ['demo-privacy.spec.ts', 'production-report.spec.ts'],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Under Bun, Nitro's default node-worker runner proxies long-lived SSE
    // responses through a second Bun server with its own ten-second timeout.
    // Keep E2E in-process so Playwright exercises the app without that
    // development-only transport hop; production tests still use the Bun host.
    command:
      'BROWSER=none NITRO_DEV_RUNNER=self TZ=UTC VITE_AI_USAGE_E2E=1 bun run dev:standalone -- --port 4174 --strictPort',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: 'http://127.0.0.1:4174',
  },
});
