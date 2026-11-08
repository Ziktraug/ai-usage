import type { WebQueryRuntime } from './composition';

let installed: WebQueryRuntime | undefined;

/** Only the mounted document provider may publish a runtime; SSR never installs one. */
export const installBrowserQueryRuntime = (runtime: WebQueryRuntime): (() => void) => {
  if (typeof window === 'undefined') {
    throw new Error('The browser query runtime cannot be installed on the server');
  }
  installed = runtime;
  return () => {
    if (installed === runtime) {
      installed = undefined;
    }
  };
};

export const browserQueryRuntime = (): WebQueryRuntime | undefined =>
  typeof window === 'undefined' ? undefined : installed;
