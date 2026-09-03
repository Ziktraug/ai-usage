import type { SharedAuthenticationService, SharedAuthenticationServiceConfig } from '../shared-authentication';

export type SharedAuthenticationServiceFactory = (
  config: SharedAuthenticationServiceConfig,
) => SharedAuthenticationService;

let injectedFactory: SharedAuthenticationServiceFactory | undefined;

export const getInjectedSharedAuthenticationServiceFactory = (): SharedAuthenticationServiceFactory | undefined =>
  injectedFactory;

export const installSharedAuthenticationServiceFactory = (
  factory: SharedAuthenticationServiceFactory,
): (() => void) => {
  const previous = injectedFactory;
  injectedFactory = factory;
  return () => {
    if (injectedFactory === factory) {
      injectedFactory = previous;
    }
  };
};
