import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 5000 },
  fullyParallel: true,
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
    command:
      'AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES=1 BROWSER=none TZ=UTC VITE_AI_USAGE_E2E=1 bun run dev -- --port 4174 --strictPort',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 8000 },
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:4174',
  },
  workers: process.env.CI ? 2 : 4,
});
