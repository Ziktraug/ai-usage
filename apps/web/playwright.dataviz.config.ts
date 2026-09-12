import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
export default defineConfig({
  testDir: './e2e',
  testMatch: 'dataviz.prototype.ts',
  workers: 1,
  timeout: 30_000,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4178',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'retain-on-failure',
  },
});
