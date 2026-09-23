declare global {
  // biome-ignore lint/style/noNamespace: SvelteKit augments its generated global App contract through this namespace.
  namespace App {
    interface Locals {
      readonly requestId?: string;
      runtimeMode?: import('./runtime-mode').RuntimeMode;
      shellE2eError?: boolean;
    }

    interface PageState {
      readonly aiUsageNavigationKey?: string;
      /** Set when the session panel opened from the report, so closing travels back to the list entry. */
      readonly aiUsageSessionPanel?: { readonly openedFromReport: true };
      readonly aiUsageSessionWindowAnchorConsumed?: true;
    }
  }
}

export {};
