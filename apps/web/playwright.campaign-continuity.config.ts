import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { CONTINUITY_HOME_RECORD_ENV } from './e2e/campaign-continuity-fixture';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
process.env[CONTINUITY_HOME_RECORD_ENV] ??= join(tmpdir(), `campaign-continuity-home-${process.pid}.json`);

export default defineConfig({
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testMatch: [
    'campaign-continuity.scale.ts',
    'campaign-period-continuity.scale.ts',
    'campaign-bootstrap-recovery.scale.ts',
  ],
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: ['--enable-precise-memory-info'],
      ...(executablePath ? { executablePath } : {}),
    },
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'AI_USAGE_PRODUCTION_E2E_PORT=4178 AI_USAGE_CAMPAIGN_CONTINUITY_E2E=1 bun e2e/production-server.ts',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://127.0.0.1:4178',
  },
  workers: 1,
});
