import { defineConfig, devices } from '@playwright/test';

/**
 * This is not a boot budget -- Playwright waits for the first successful response, which means Vite
 * has optimised the dependency graph and transformed the app for SSR.
 *
 * Sized from measured CI cold starts, spawn to first test, on ubuntu-latest with two workers:
 * 6.87s, 6.88s, 7.02s across three consecutive green runs on 2026-08-25. The spread is under 150ms,
 * so 20s is ~3x headroom, not a squeeze.
 *
 * The previous 300s came from reading two "never became ready" failures as slowness. They were not:
 * a known `bun --bun vite` startup hang never becomes ready at any deadline, so a larger number
 * only buys a slower red. If this trips on runs that would otherwise pass, read the piped server
 * output below before raising it -- a miss here is a hang, not a slow start.
 */
const WEB_SERVER_COLD_START_TIMEOUT_MS = 20_000;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  expect: { timeout: 5000 },
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'line',
  testDir: './e2e',
  testIgnore: ['demo-isolation.spec.ts', 'production-report.spec.ts'],
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
    // Playwright forwards stderr by default but discards stdout, and Vite reports readiness on
    // stdout. Without this the log of a hung start ends at an unrelated SvelteKit stderr warning
    // and the actual startup trace is thrown away, leaving nothing to diagnose.
    stdout: 'pipe',
    timeout: WEB_SERVER_COLD_START_TIMEOUT_MS,
    url: 'http://127.0.0.1:4174',
  },
  workers: process.env.CI ? 2 : 4,
});
