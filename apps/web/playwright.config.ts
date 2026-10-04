import { defineConfig, devices } from '@playwright/test';

/**
 * A cold Bun/Vite start can stall when HTTP readiness probes arrive before Vite has
 * finished initializing. Wait for its strict loopback listener announcement instead;
 * the browser suite then verifies the real HTTP response. Do not combine this with a
 * webServer URL: Playwright races output and HTTP readiness instead of sequencing them.
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
    wait: { stdout: /Local:\s+http:\/\/127\.0\.0\.1:4174\// },
  },
  workers: process.env.CI ? 2 : 4,
});
