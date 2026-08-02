import { expect, test } from 'bun:test';
import path from 'node:path';
import { checkSvelteKitRuntimeLifecycle } from './check-sveltekit-runtime-lifecycle';

test('observes SSR and a greater-than-30-second SSE before clean signal shutdown', async () => {
  const fixture = path.join(import.meta.dir, 'fixtures', 'sveltekit-runtime', 'server.mjs');
  const result = await checkSvelteKitRuntimeLifecycle({
    artifactDirectory: path.dirname(fixture),
    command: () => [process.execPath, '--no-env-file', '--no-install', fixture, '31100'],
    minimumSseHoldMs: 30_000,
    ssrMarker: 'data-runtime-fixture="sveltekit-bun"',
  });
  expect(result.heldForMs).toBeGreaterThanOrEqual(30_000);
  expect(result.port).toBeGreaterThan(0);
  expect(result.startTimeTicks).not.toBe('');
  expect(() => process.kill(result.pid, 0)).toThrow();
}, 40_000);
