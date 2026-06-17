import { themeToggleButton } from '@ai-usage/design-system';
import { createSignal, onCleanup, Show } from 'solid-js';

const THEME_STORAGE_KEY = 'ai-usage-theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

const storedTheme = (): 'light' | 'dark' | null => {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
};

const SunIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4.4" />
    <path d="M12 2.2v2.6M12 19.2v2.6M21.8 12h-2.6M4.8 12H2.2M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8M18.9 18.9l-1.8-1.8M6.9 6.9 5.1 5.1" />
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.6 14.4A8.7 8.7 0 0 1 9.6 3.4a8.7 8.7 0 1 0 11 11Z" />
  </svg>
);

// Two-state toggle: follow the OS by default, pin the opposite scheme on
// click. A pin that lands back on the OS value clears to auto, so the report
// keeps tracking system changes unless the user actually diverges from them.
export const ThemeToggle = () => {
  const [theme, setTheme] = createSignal<'light' | 'dark'>(storedTheme() ?? (prefersDark.matches ? 'dark' : 'light'));
  const handleSystemChange = (event: MediaQueryListEvent) => {
    if (!storedTheme()) setTheme(event.matches ? 'dark' : 'light');
  };
  prefersDark.addEventListener('change', handleSystemChange);
  onCleanup(() => prefersDark.removeEventListener('change', handleSystemChange));

  const toggle = () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    const followsSystem = next === (prefersDark.matches ? 'dark' : 'light');
    setTheme(next);
    try {
      if (followsSystem) localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Without storage the pin still applies for the lifetime of the page.
    }
    if (followsSystem) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', followsSystem ? 'light dark' : next);
  };

  return (
    <button
      class={themeToggleButton}
      type="button"
      onClick={toggle}
      aria-label={theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Show when={theme() === 'dark'} fallback={<SunIcon />}>
        <MoonIcon />
      </Show>
    </button>
  );
};
