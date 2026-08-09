import { describe, expect, test } from 'bun:test';
import type { StateListener, StateSubscription } from '../../subscription';
import {
  type BeforeUnloadEventLike,
  createDirtyNavigationController,
  type DirtyBeforeNavigate,
  installDirtyNavigationBridge,
} from './dirty-navigation';
import { createMemoryNavigationPort } from './navigation';

const navigation = (overrides: Partial<DirtyBeforeNavigate> = {}) => {
  let cancelled = false;
  return {
    event: {
      cancel: () => {
        cancelled = true;
      },
      to: { url: new URL('http://local/next') },
      type: 'link',
      willUnload: false,
      ...overrides,
    } satisfies DirtyBeforeNavigate,
    wasCancelled: () => cancelled,
  };
};

describe('dirty navigation controller', () => {
  test('synchronously blocks one target, Keep retains history and returns focus', () => {
    let dirty = true;
    let focused = 0;
    const replayed: unknown[] = [];
    const controller = createDirtyNavigationController({
      discardChanges: () => {
        dirty = false;
      },
      focus: () => {
        focused += 1;
      },
      isDirty: () => dirty,
      replay: (target) => {
        replayed.push(target);
      },
    });
    const first = navigation();
    const second = navigation({ to: { url: new URL('http://local/other') } });
    expect(controller.handle(first.event)).toBe(true);
    expect(first.wasCancelled()).toBe(true);
    controller.handle(second.event);
    expect(controller.pending()).toEqual({ kind: 'url', url: new URL('http://local/next') });
    controller.keep();
    expect(controller.pending()).toBeUndefined();
    expect(replayed).toEqual([]);
    expect(focused).toBe(1);
    const history = createMemoryNavigationPort('http://local/current?utm=kept');
    expect(history.currentUrl().href).toBe('http://local/current?utm=kept');
    expect(history.entries()).toHaveLength(1);
  });

  test('[url:history.replace-push-back-forward] Discard replays popstate exactly once after clearing dirty state', async () => {
    let dirty = true;
    const replayed: unknown[] = [];
    const controller = createDirtyNavigationController({
      discardChanges: () => {
        dirty = false;
      },
      focus: () => undefined,
      isDirty: () => dirty,
      replay: (target) => {
        replayed.push(target);
      },
    });
    const back = navigation({ delta: -1, to: { url: new URL('http://local/previous') }, type: 'popstate' });
    controller.handle(back.event);
    expect(back.wasCancelled()).toBe(true);
    expect(await controller.discard()).toBe(true);
    expect(await controller.discard()).toBe(false);
    expect(replayed).toEqual([{ delta: -1, kind: 'history' }]);
  });

  test('uses the native unload path without retaining an unreplayable external target', () => {
    const controller = createDirtyNavigationController({
      discardChanges: () => undefined,
      focus: () => undefined,
      isDirty: () => true,
      replay: () => undefined,
    });
    const leave = navigation({ to: null, type: 'leave', willUnload: true });
    controller.handle(leave.event);
    expect(leave.wasCancelled()).toBe(true);
    expect(controller.pending()).toBeUndefined();
  });

  test('attaches beforeunload only while dirty and disposes listeners idempotently', () => {
    let dirty = false;
    const dirtyListeners = new Set<StateListener<boolean>>();
    const source: StateSubscription<boolean> = {
      getState: () => dirty,
      subscribe: (listener) => {
        dirtyListeners.add(listener);
        return () => dirtyListeners.delete(listener);
      },
    };
    const unloadListeners = new Set<(event: BeforeUnloadEventLike) => void>();
    let navigationListener: ((event: DirtyBeforeNavigate) => void) | undefined;
    let navigationDisposed = 0;
    const controller = createDirtyNavigationController({
      discardChanges: () => undefined,
      focus: () => undefined,
      isDirty: () => dirty,
      replay: () => undefined,
    });
    const dispose = installDirtyNavigationBridge({
      beforeNavigate: (listener) => {
        navigationListener = listener;
        return () => {
          navigationDisposed += 1;
        };
      },
      controller,
      dirty: source,
      window: {
        addEventListener: (_type, listener) => unloadListeners.add(listener),
        removeEventListener: (_type, listener) => unloadListeners.delete(listener),
      },
    });
    expect(navigationListener).toBeDefined();
    expect(unloadListeners.size).toBe(0);
    dirty = true;
    for (const listener of dirtyListeners) {
      listener(dirty);
    }
    expect(unloadListeners.size).toBe(1);
    const unload = { preventDefault: () => undefined, returnValue: 'unchanged' };
    unloadListeners.values().next().value?.(unload);
    expect(unload.returnValue).toBe('');
    dirty = false;
    for (const listener of dirtyListeners) {
      listener(dirty);
    }
    expect(unloadListeners.size).toBe(0);
    dispose();
    dispose();
    expect(navigationDisposed).toBe(1);
    expect(dirtyListeners.size).toBe(0);
  });
});
