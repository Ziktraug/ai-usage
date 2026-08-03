import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 5000 },
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: 'svelte-shell.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    ...devices['Desktop Chrome'],
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun --no-env-file e2e/svelte-shadow-server.ts',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 8000 },
    reuseExistingServer: false,
    timeout: 30_000,
    url: 'http://127.0.0.1:4178',
  },
  workers: 1,
});
