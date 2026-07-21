import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: '**/*.scale.ts',
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:4177',
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--enable-precise-memory-info'],
      ...(executablePath ? { executablePath } : {}),
    },
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'AI_USAGE_PRODUCTION_E2E_PORT=4177 AI_USAGE_SESSION_SCALE_E2E=1 bun e2e/production-server.ts',
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://127.0.0.1:4177',
  },
  workers: 1,
});
