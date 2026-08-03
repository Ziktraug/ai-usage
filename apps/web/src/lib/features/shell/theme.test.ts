import { describe, expect, test } from 'bun:test';
import { createThemeController, type Theme, type ThemePort } from './theme';

const createThemeFixture = (initial: { stored: Theme | null; system: Theme }) => {
  let stored = initial.stored;
  let system = initial.system;
  const applied: (Theme | null)[] = [];
  const listeners = new Set<(theme: Theme) => void>();
  const port: ThemePort = {
    apply: (theme) => applied.push(theme),
    clearStored: () => {
      stored = null;
    },
    readStored: () => stored,
    setStored: (theme) => {
      stored = theme;
    },
    subscribeSystem: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    system: () => system,
  };
  return {
    applied,
    emitSystem: (theme: Theme) => {
      system = theme;
      for (const listener of listeners) {
        listener(theme);
      }
    },
    listeners,
    port,
    stored: () => stored,
  };
};

describe('Svelte shell theme controller', () => {
  test('uses a stored pin and ignores system changes while pinned', () => {
    const fixture = createThemeFixture({ stored: 'dark', system: 'light' });
    const controller = createThemeController(fixture.port);
    const observed: Theme[] = [];
    const stop = controller.start((theme) => observed.push(theme));
    fixture.emitSystem('dark');

    expect(observed).toEqual(['dark']);
    expect(controller.current()).toBe('dark');
    stop();
    expect(fixture.listeners.size).toBe(0);
  });

  test('clears a pin that matches the system and resumes live system updates', () => {
    const fixture = createThemeFixture({ stored: null, system: 'light' });
    const controller = createThemeController(fixture.port);
    const observed: Theme[] = [];
    const stop = controller.start((theme) => observed.push(theme));

    controller.set('dark');
    expect(fixture.stored()).toBe('dark');
    expect(fixture.applied.at(-1)).toBe('dark');
    controller.set('light');
    expect(fixture.stored()).toBeNull();
    expect(fixture.applied.at(-1)).toBeNull();
    fixture.emitSystem('dark');
    expect(observed).toEqual(['light', 'dark']);
    stop();
  });

  test('rejects two active mounts and allows a clean remount', () => {
    const fixture = createThemeFixture({ stored: null, system: 'light' });
    const controller = createThemeController(fixture.port);
    const stop = controller.start(() => undefined);
    expect(() => controller.start(() => undefined)).toThrow('already started');
    stop();
    const stopAgain = controller.start(() => undefined);
    stopAgain();
  });
});
