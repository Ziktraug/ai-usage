import { describe, expect, test } from 'bun:test';
import type { StateListener } from '../../foundation/subscription';
import { createDirtyGuardRegistry } from './dirty-navigation-context';

describe('Svelte shell dirty navigation registry', () => {
  test('is inert by default and forwards one registered guard', async () => {
    const registry = createDirtyGuardRegistry();
    const dirtyListeners = new Set<StateListener<boolean>>();
    let dirty = false;
    let discarded = 0;
    let focused = 0;
    const stop = registry.register({
      dirty: {
        getState: () => dirty,
        subscribe: (listener) => {
          dirtyListeners.add(listener);
          return () => dirtyListeners.delete(listener);
        },
      },
      discard: () => {
        discarded += 1;
      },
      focus: () => {
        focused += 1;
      },
    });

    dirty = true;
    for (const listener of dirtyListeners) {
      listener(dirty);
    }
    expect(registry.dirty.getState()).toBe(true);
    await registry.discard();
    registry.focus();
    expect({ discarded, focused }).toEqual({ discarded: 1, focused: 1 });
    expect(() =>
      registry.register({ dirty: registry.dirty, discard: () => undefined, focus: () => undefined }),
    ).toThrow('already registered');

    stop();
    stop();
    expect(registry.dirty.getState()).toBe(false);
    expect(dirtyListeners.size).toBe(0);
  });
});
