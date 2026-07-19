export const PERSISTENT_SOURCE_RUNTIME_PACKAGES = [
  '@ai-usage/local-collectors',
  '@ai-usage/report-core',
  '@ai-usage/report-data',
  '@ai-usage/skills',
  '@ai-usage/usage-store',
] as const;

type BeforeFullReloadListener = (payload: unknown) => Promise<void> | void;

export interface ViteHotReloadPort {
  readonly off: (event: 'vite:beforeFullReload', listener: BeforeFullReloadListener) => void;
  readonly on: (event: 'vite:beforeFullReload', listener: BeforeFullReloadListener) => void;
}

const BEFORE_FULL_RELOAD_EVENT = 'vite:beforeFullReload' as const;

export const registerPersistentSourceRuntimeHotReload = (
  hot: ViteHotReloadPort | undefined,
  closeRuntime: () => Promise<void>,
): (() => void) => {
  if (!hot) {
    return () => undefined;
  }

  let registered = true;
  const unregister = () => {
    if (!registered) {
      return;
    }
    registered = false;
    hot.off(BEFORE_FULL_RELOAD_EVENT, beforeFullReload);
  };
  const beforeFullReload: BeforeFullReloadListener = async () => {
    unregister();
    await closeRuntime();
  };

  hot.on(BEFORE_FULL_RELOAD_EVENT, beforeFullReload);
  return unregister;
};
