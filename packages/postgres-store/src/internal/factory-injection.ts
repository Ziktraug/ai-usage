import type { PlatformStore, PlatformStoreConfig } from '../writer';

export type PlatformStoreFactory = (config: PlatformStoreConfig) => Promise<PlatformStore>;

let injectedFactory: PlatformStoreFactory | undefined;

export const getInjectedPlatformStoreFactory = (): PlatformStoreFactory | undefined => injectedFactory;

export const installPlatformStoreFactory = (factory: PlatformStoreFactory): (() => void) => {
  const previousFactory = injectedFactory;
  injectedFactory = factory;
  return (): void => {
    injectedFactory = previousFactory;
  };
};
