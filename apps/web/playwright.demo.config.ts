import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: 'demo-privacy.spec.ts',
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
    command: 'bun --no-env-file ../../tools/run-web-demo.ts',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:4176',
  },
});
