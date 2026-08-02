declare global {
  // biome-ignore lint/style/noNamespace: SvelteKit augments its generated global App contract through this namespace.
  namespace App {
    interface Locals {
      readonly requestId?: string;
    }
  }
}

export {};
