/**
 * Playwright starts the Vite dev server and then runs this before the first test. A cold Vite
 * transforms each route's module graph on its first request; with two CI workers opening the two
 * heaviest routes at once, that first transform exceeded a 30-second test timeout and surfaced
 * as an aborted navigation. Requesting the routes once here, sequentially and outside any test
 * budget, moves that cost where it belongs. It never asserts: a route that fails to warm fails
 * its own test with a real message.
 */
import type { FullConfig } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4174';
const WARM_ROUTES = ['/', '/work', '/sessions', '/analysis', '/campaigns', '/skills', '/sources', '/sync'] as const;
const PER_ROUTE_TIMEOUT_MS = 120_000;

const warmRoute = async (baseUrl: string, route: string): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_ROUTE_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(route, baseUrl), { signal: controller.signal });
    await response.arrayBuffer();
  } catch {
    // Reported by the route's own test, with the browser's diagnostics.
  } finally {
    clearTimeout(timer);
  }
};

export default async function warmDevServer(config: FullConfig): Promise<void> {
  // Each config that reuses this setup warms its own server.
  const baseUrl = config.projects[0]?.use.baseURL ?? DEFAULT_BASE_URL;
  for (const route of WARM_ROUTES) {
    await warmRoute(baseUrl, route);
  }
}
