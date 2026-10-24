import { getContext, setContext } from 'svelte';
import type { SvelteGotoOptions } from '../../foundation/navigation/svelte/navigation';

type ShellGotoOptions = SvelteGotoOptions & { readonly state?: App.PageState };
type FrameworkGotoOptions = Omit<ShellGotoOptions, 'preserveScroll'>;
type ShellGoto = (url: string | URL, options?: ShellGotoOptions) => Promise<void>;

export interface ShellNavigationIntent {
  readonly preserveScroll: boolean;
  readonly replace: boolean;
}

export interface ShellNavigationOwner {
  readonly consumeIntent: (type: string, url: { readonly href: string } | null) => ShellNavigationIntent;
  readonly goto: ShellGoto;
}

const navigationOwnerContextKey = Symbol('ai-usage-navigation-owner');
const unmarkedNavigation: ShellNavigationIntent = { preserveScroll: false, replace: false };

const frameworkGotoOptions = (options: ShellGotoOptions | undefined): FrameworkGotoOptions | undefined => {
  if (options?.preserveScroll === undefined) {
    return options;
  }
  const { preserveScroll: _consumedByShell, ...frameworkOptions } = options;
  return frameworkOptions;
};

/**
 * SvelteKit's beforeNavigate exposes neither goto's `replace` option nor the scroll preservation
 * SvelteKit 3 no longer has an option for. Keep both intents beside the shell which owns history
 * keys and scroll, scoped to the exact destination and lifetime of each navigation. An aborted or
 * rejected goto cannot leave a mark for an unrelated later navigation.
 */
export const createShellNavigationOwner = (port: {
  readonly currentUrl: () => { readonly href: string };
  readonly goto: (url: string | URL, options?: FrameworkGotoOptions) => Promise<void>;
}): ShellNavigationOwner => {
  const pending = new Map<string, ShellNavigationIntent & { readonly identity: symbol }>();
  return {
    consumeIntent: (type, url) => {
      if (type !== 'goto' || url === null) {
        return unmarkedNavigation;
      }
      const intent = pending.get(url.href);
      if (!intent) {
        return unmarkedNavigation;
      }
      pending.delete(url.href);
      return { preserveScroll: intent.preserveScroll, replace: intent.replace };
    },
    goto: async (url, options) => {
      const identity = Symbol('navigation');
      const href = new URL(url, port.currentUrl().href).href;
      pending.set(href, {
        identity,
        preserveScroll: options?.preserveScroll === true,
        replace: options?.replace === true,
      });
      try {
        await port.goto(url, frameworkGotoOptions(options));
      } finally {
        if (pending.get(href)?.identity === identity) {
          pending.delete(href);
        }
      }
    },
  };
};

export const provideShellNavigationOwner = (owner: ShellNavigationOwner): void => {
  setContext(navigationOwnerContextKey, owner);
};

export const useShellNavigationOwner = (): ShellNavigationOwner => {
  const owner = getContext<ShellNavigationOwner | undefined>(navigationOwnerContextKey);
  if (!owner) {
    throw new Error('Shell navigation context is unavailable');
  }
  return owner;
};
