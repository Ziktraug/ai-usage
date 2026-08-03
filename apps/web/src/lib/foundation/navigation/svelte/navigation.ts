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

export interface ScrollLifecycleEvent {
  readonly fromKey: string;
  readonly requestedReset?: boolean;
  readonly toKey: string;
  readonly type: 'enter' | 'form' | 'goto' | 'leave' | 'link' | 'popstate';
}

export interface ScrollLifecycle {
  readonly cancel: () => void;
  readonly dispose: () => void;
}

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

export const installScrollLifecycle = (dependencies: {
  readonly afterNavigate: (listener: (event: Pick<ScrollLifecycleEvent, 'toKey'>) => void) => Disposer | undefined;
  readonly afterRender: (callback: () => void) => Disposer | undefined;
  readonly beforeNavigate: (listener: (event: ScrollLifecycleEvent) => void) => Disposer | undefined;
  readonly position: () => { readonly x: number; readonly y: number };
  readonly scrollTo: (position: { readonly x: number; readonly y: number }) => void;
}): ScrollLifecycle => {
  const positions = new Map<string, { readonly x: number; readonly y: number }>();
  let generation = 0;
  let disposed = false;
  let pending:
    | {
        readonly generation: number;
        readonly position: { x: number; y: number };
        readonly toKey: string;
      }
    | undefined;
  let cancelScheduled: Disposer | undefined;
  const cancel = (): void => {
    generation += 1;
    pending = undefined;
    cancelScheduled?.();
    cancelScheduled = undefined;
  };
  const stopBefore = dependencies.beforeNavigate((event) => {
    if (disposed) {
      return;
    }
    cancel();
    const outgoing = dependencies.position();
    positions.set(event.fromKey, outgoing);
    const restored = event.type === 'popstate' ? positions.get(event.toKey) : undefined;
    const directive = scrollDirectiveFor({
      ...(event.requestedReset === undefined ? {} : { requestedReset: event.requestedReset }),
      ...(restored === undefined ? {} : { restoredPosition: restored }),
      type: event.type,
    });
    if (directive.kind !== 'framework') {
      let position = outgoing;
      if (directive.kind === 'restore') {
        position = directive;
      } else if (directive.kind === 'reset') {
        position = { x: 0, y: 0 };
      }
      pending = {
        generation,
        position,
        toKey: event.toKey,
      };
    }
  });
  const stopAfter = dependencies.afterNavigate(({ toKey }) => {
    const task = pending;
    if (!(task && task.toKey === toKey && !disposed)) {
      return;
    }
    pending = undefined;
    let completedSynchronously = false;
    const scheduled = dependencies.afterRender(() => {
      completedSynchronously = true;
      if (!(disposed || task.generation !== generation)) {
        cancelScheduled = undefined;
        dependencies.scrollTo(task.position);
      }
    });
    cancelScheduled = completedSynchronously ? undefined : scheduled;
  });
  return {
    cancel,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        cancel();
        stopBefore?.();
        stopAfter?.();
        positions.clear();
      }
    },
  };
};

export type DrawerIdentity =
  | { readonly kind: 'local'; readonly rowKey: string }
  | { readonly campaignKey: string; readonly kind: 'served'; readonly revision: string; readonly rowKey: string };

export const createDrawerIdentityOwner = () => {
  let identity: DrawerIdentity | undefined;
  return {
    clear: () => {
      identity = undefined;
    },
    current: () => identity,
    select: (next: DrawerIdentity) => {
      identity = next;
    },
  };
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

import type { Disposer } from '../../subscription';
