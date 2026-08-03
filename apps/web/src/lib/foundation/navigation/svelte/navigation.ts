export interface NavigationIntent {
  readonly keepFocus?: boolean;
  readonly replace?: boolean;
  readonly resetScroll?: boolean;
  readonly url: string | URL;
}

export interface NavigationPort {
  readonly currentUrl: () => URL;
  readonly navigate: (intent: NavigationIntent) => Promise<void>;
  readonly traverse: (delta: number) => void;
}

export interface SvelteGotoOptions {
  readonly keepFocus?: boolean;
  readonly noScroll?: boolean;
  readonly replaceState?: boolean;
}

export interface NavigationFailure {
  readonly cause: unknown;
  readonly intent: NavigationIntent;
}

export type ScrollDirective =
  | { readonly kind: 'framework' }
  | { readonly kind: 'preserve' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'restore'; readonly x: number; readonly y: number };

export const scrollDirectiveFor = (input: {
  readonly requestedReset?: boolean;
  readonly restoredPosition?: { readonly x: number; readonly y: number } | null;
  readonly type: 'enter' | 'form' | 'goto' | 'leave' | 'link' | 'popstate';
}): ScrollDirective => {
  if (input.type === 'popstate' && input.restoredPosition) {
    return { kind: 'restore', ...input.restoredPosition };
  }
  if (input.requestedReset === false) {
    return { kind: 'preserve' };
  }
  if (input.requestedReset === true) {
    return { kind: 'reset' };
  }
  return { kind: 'framework' };
};

export const createSvelteNavigationPort = (dependencies: {
  readonly getCurrentUrl: () => URL;
  readonly goto: (url: string | URL, options?: SvelteGotoOptions) => Promise<void>;
  readonly history: Pick<History, 'go'>;
  readonly onFailure?: (failure: NavigationFailure) => void;
}): NavigationPort => ({
  currentUrl: () => new URL(dependencies.getCurrentUrl()),
  navigate: async (intent) => {
    try {
      await dependencies.goto(intent.url, {
        ...(intent.keepFocus === undefined ? {} : { keepFocus: intent.keepFocus }),
        ...(intent.replace === undefined ? {} : { replaceState: intent.replace }),
        ...(intent.resetScroll === undefined ? {} : { noScroll: !intent.resetScroll }),
      });
    } catch (cause) {
      dependencies.onFailure?.({ cause, intent });
      throw cause;
    }
  },
  traverse: (delta) => {
    if (Number.isInteger(delta) && delta !== 0) {
      dependencies.history.go(delta);
    }
  },
});

export interface MemoryNavigationPort extends NavigationPort {
  readonly entries: () => readonly URL[];
  readonly index: () => number;
}

export const createMemoryNavigationPort = (initialUrl: string | URL): MemoryNavigationPort => {
  const history = [new URL(initialUrl)];
  let currentIndex = 0;
  return {
    currentUrl: () => new URL(history[currentIndex] as URL),
    entries: () => history.map((url) => new URL(url)),
    index: () => currentIndex,
    navigate: (intent) => {
      const next = new URL(intent.url, history[currentIndex]);
      if (intent.replace) {
        history[currentIndex] = next;
        return Promise.resolve();
      }
      history.splice(currentIndex + 1, history.length, next);
      currentIndex += 1;
      return Promise.resolve();
    },
    traverse: (delta) => {
      if (!Number.isInteger(delta) || delta === 0) {
        return;
      }
      const nextIndex = currentIndex + delta;
      if (nextIndex >= 0 && nextIndex < history.length) {
        currentIndex = nextIndex;
      }
    },
  };
};
