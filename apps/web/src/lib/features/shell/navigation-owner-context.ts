import { getContext, setContext } from 'svelte';
import type { SvelteGotoOptions } from '../../foundation/navigation/svelte/navigation';

type ShellGotoOptions = SvelteGotoOptions & { readonly state?: App.PageState };
type ShellGoto = (url: string | URL, options?: ShellGotoOptions) => Promise<void>;

export interface ShellNavigationOwner {
  readonly consumeReplacement: (type: string, url: URL | null) => boolean;
  readonly goto: ShellGoto;
}

const navigationOwnerContextKey = Symbol('ai-usage-navigation-owner');

/**
 * SvelteKit's beforeNavigate does not expose goto's replaceState option. Keep
 * that intent beside the shell which owns history keys, scoped to the exact
 * destination and lifetime of each navigation. An aborted or rejected goto
 * cannot leave a replacement mark for an unrelated later navigation.
 */
export const createShellNavigationOwner = (port: {
  readonly currentUrl: () => URL;
  readonly goto: ShellGoto;
}): ShellNavigationOwner => {
  const pending = new Map<string, { readonly identity: symbol; readonly replace: boolean }>();
  return {
    consumeReplacement: (type, url) => {
      if (type !== 'goto' || url === null) {
        return false;
      }
      const intent = pending.get(url.href);
      if (intent) {
        pending.delete(url.href);
        return intent.replace;
      }
      return false;
    },
    goto: async (url, options) => {
      const identity = Symbol('navigation');
      const href = new URL(url, port.currentUrl()).href;
      pending.set(href, {
        identity,
        replace: options?.replaceState === true,
      });
      try {
        await port.goto(url, options);
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
