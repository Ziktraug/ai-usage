import { describe, expect, test } from 'bun:test';
import {
  PERSISTENT_SOURCE_RUNTIME_PACKAGES,
  registerPersistentSourceRuntimeHotReload,
  type ViteHotReloadPort,
} from './persistent-source-runtime';

type HotReloadListener = (payload: unknown) => Promise<void> | void;

const hotReloadFixture = () => {
  const listeners = new Map<string, Set<HotReloadListener>>();
  const hot: ViteHotReloadPort = {
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    on: (event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set<HotReloadListener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
  };
  return { hot, listeners };
};

describe('persistent source runtime hot reload', () => {
  test('keeps every source-runtime workspace package inside the Nitro module graph', () => {
    expect(PERSISTENT_SOURCE_RUNTIME_PACKAGES).toEqual([
      '@ai-usage/local-collectors',
      '@ai-usage/report-core',
      '@ai-usage/report-data',
      '@ai-usage/skills',
      '@ai-usage/usage-store',
    ]);
    expect(PERSISTENT_SOURCE_RUNTIME_PACKAGES).not.toContain('@ai-usage/design-system');
  });

  test('awaits teardown before a full reload and unregisters the old listener', async () => {
    const { hot, listeners } = hotReloadFixture();
    let closeCount = 0;
    registerPersistentSourceRuntimeHotReload(hot, () => {
      closeCount += 1;
      return Promise.resolve();
    });

    const listener = [...(listeners.get('vite:beforeFullReload') ?? [])][0];
    expect(listener).toBeDefined();
    await listener?.({ type: 'full-reload' });

    expect(closeCount).toBe(1);
    expect(listeners.get('vite:beforeFullReload')?.size).toBe(0);
  });

  test('returns an idempotent unregister function outside and inside HMR', () => {
    const { hot, listeners } = hotReloadFixture();
    const unregister = registerPersistentSourceRuntimeHotReload(hot, async () => undefined);

    unregister();
    unregister();

    expect(listeners.get('vite:beforeFullReload')?.size).toBe(0);
    expect(registerPersistentSourceRuntimeHotReload(undefined, async () => undefined)).toBeInstanceOf(Function);
  });
});
