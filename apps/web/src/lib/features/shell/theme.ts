export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'ai-usage-theme';

export interface ThemePort {
  readonly apply: (preference: Theme | null) => void;
  readonly clearStored: () => void;
  readonly readStored: () => Theme | null;
  readonly setStored: (theme: Theme) => void;
  readonly subscribeSystem: (listener: (theme: Theme) => void) => () => void;
  readonly system: () => Theme;
}

export interface ThemeController {
  readonly current: () => Theme;
  readonly set: (theme: Theme) => void;
  readonly start: (listener: (theme: Theme) => void) => () => void;
}

export const createThemeController = (port: ThemePort): ThemeController => {
  let current = port.readStored() ?? port.system();
  let started = false;
  let activeListener: ((theme: Theme) => void) | undefined;
  let stopSystem: (() => void) | undefined;
  const syncSystemSubscription = (): void => {
    stopSystem?.();
    stopSystem = undefined;
    if (!(started && activeListener && !port.readStored())) {
      return;
    }
    stopSystem = port.subscribeSystem((theme) => {
      current = theme;
      activeListener?.(theme);
      port.apply(null);
    });
  };
  return {
    current: () => current,
    set: (theme) => {
      current = theme;
      if (theme === port.system()) {
        port.clearStored();
        port.apply(null);
      } else {
        port.setStored(theme);
        port.apply(theme);
      }
      syncSystemSubscription();
    },
    start: (listener) => {
      if (started) {
        throw new Error('Theme controller is already started');
      }
      started = true;
      activeListener = listener;
      current = port.readStored() ?? port.system();
      listener(current);
      syncSystemSubscription();
      return () => {
        if (started) {
          started = false;
          activeListener = undefined;
          stopSystem?.();
          stopSystem = undefined;
        }
      };
    },
  };
};

export const browserThemePort = (): ThemePort => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const readStored = (): Theme | null => {
    try {
      const value = localStorage.getItem(THEME_STORAGE_KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  };
  return {
    apply: (preference) => {
      if (preference) {
        document.documentElement.dataset.theme = preference;
      } else {
        delete document.documentElement.dataset.theme;
      }
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', preference ?? 'light dark');
    },
    clearStored: () => {
      try {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } catch {
        // Storage can be unavailable while the in-memory theme remains usable.
      }
    },
    readStored,
    setStored: (theme) => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // Storage can be unavailable while the in-memory theme remains usable.
      }
    },
    subscribeSystem: (listener) => {
      const onChange = (event: MediaQueryListEvent): void => listener(event.matches ? 'dark' : 'light');
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    system: () => (media.matches ? 'dark' : 'light'),
  };
};
