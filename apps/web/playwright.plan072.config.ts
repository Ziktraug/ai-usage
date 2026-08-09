import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: '**/plan072-*.benchmark.ts',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'AI_USAGE_PRODUCTION_E2E_PORT=4178 AI_USAGE_SESSION_SCALE_E2E=1 AI_USAGE_PERF=1 bun e2e/production-server.ts',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://127.0.0.1:4178',
  },
  workers: 1,
});
