import { describe, expect, test } from 'bun:test';
import {
  createSessionSurfaceModeController,
  SESSION_DESKTOP_MEDIA_QUERY,
  type SessionSurfaceMode,
} from './session-surface-mode';

describe('session surface mode controller', () => {
  test('starts pending, follows viewport changes, and restores the viewport after print', () => {
    let mediaMatches = false;
    const mediaListeners = new Set<(event: { matches: boolean }) => void>();
    const printListeners = {
      afterprint: new Set<() => void>(),
      beforeprint: new Set<() => void>(),
    };
    let requestedQuery = '';
    const controller = createSessionSurfaceModeController({
      matchMedia: (query) => {
        requestedQuery = query;
        return {
          get matches() {
            return mediaMatches;
          },
          addEventListener: (_type, listener) => mediaListeners.add(listener),
          removeEventListener: (_type, listener) => mediaListeners.delete(listener),
        };
      },
      printEvents: {
        addEventListener: (type, listener) => printListeners[type].add(listener),
        removeEventListener: (type, listener) => printListeners[type].delete(listener),
      },
    });
    const modes: SessionSurfaceMode[] = [];

    expect(controller.mode()).toBe('pending');
    const stop = controller.start((mode) => modes.push(mode));
    mediaMatches = true;
    for (const listener of mediaListeners) {
      listener({ matches: true });
    }
    for (const listener of printListeners.beforeprint) {
      listener();
    }
    mediaMatches = false;
    for (const listener of mediaListeners) {
      listener({ matches: false });
    }
    expect(controller.mode()).toBe('print');
    for (const listener of printListeners.afterprint) {
      listener();
    }

    expect(requestedQuery).toBe(SESSION_DESKTOP_MEDIA_QUERY);
    expect(modes).toEqual(['mobile', 'desktop', 'print', 'mobile']);
    stop();
    expect(controller.mode()).toBe('pending');
    expect(mediaListeners.size).toBe(0);
    expect(printListeners.beforeprint.size).toBe(0);
    expect(printListeners.afterprint.size).toBe(0);
  });

  test('rejects duplicate starts while listeners are active', () => {
    const controller = createSessionSurfaceModeController({
      matchMedia: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      printEvents: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    const stop = controller.start(() => undefined);

    expect(() => controller.start(() => undefined)).toThrow('already started');
    stop();
  });
});
