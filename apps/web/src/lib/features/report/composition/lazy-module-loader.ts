export type LazyModuleLoadResult = 'failed' | 'loaded';

export interface LazyModuleLoader {
  readonly load: () => Promise<LazyModuleLoadResult>;
  readonly retry: () => Promise<LazyModuleLoadResult>;
  readonly start: () => void;
}

export const createLazyModuleLoader = <Module>({
  importModule,
  onFailureChange,
  onLoaded,
}: {
  readonly importModule: () => Promise<Module>;
  readonly onFailureChange: (failed: boolean) => void;
  readonly onLoaded: (module: Module) => void;
}): LazyModuleLoader => {
  let active: Promise<LazyModuleLoadResult> | undefined;
  const start = (): void => {
    if (active) {
      return;
    }
    const run = async (): Promise<LazyModuleLoadResult> => {
      onFailureChange(false);
      try {
        onLoaded(await importModule());
        return 'loaded';
      } catch {
        onFailureChange(true);
        return 'failed';
      } finally {
        active = undefined;
      }
    };
    active = run();
  };
  const load = (): Promise<LazyModuleLoadResult> => {
    start();
    if (!active) {
      throw new Error('Lazy module load did not start.');
    }
    return active;
  };
  return { load, retry: load, start };
};
