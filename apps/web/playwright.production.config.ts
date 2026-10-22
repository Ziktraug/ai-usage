import { defineConfig, devices } from '@playwright/test';

/**
 * Sized from measured CI cold starts, spawn to first test: 2.4s to 5.2s across the three server
 * launches in the 2026-08-25 green run. These servers start from a finished build, so startup is a
 * process launch, not a transform. 20s is ~4x headroom; a miss is a hang, not a slow start, and a
 * larger number only buys a slower red.
 */
const WEB_SERVER_COLD_START_TIMEOUT_MS = 20_000;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  // The review attempt spec needs the fixture that production-server.ts seeds only under this flag.
  testIgnore: [
    'work-codex-production.spec.ts',
    'work-codex-native.spec.ts',
    ...(process.env.AI_USAGE_WORK_ATTEMPT_E2E === '1' ? [] : ['work-attempt-production.spec.ts']),
  ],
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
