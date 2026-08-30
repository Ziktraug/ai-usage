import {
  installSharedAuthenticationServiceFactory,
  type SharedAuthenticationServiceFactory,
} from './internal/shared-authentication-factory';

export const installSharedAuthenticationServiceFactoryForTesting = (
  factory: SharedAuthenticationServiceFactory,
): (() => void) => installSharedAuthenticationServiceFactory(factory);

export type { SharedAuthenticationServiceFactory } from './internal/shared-authentication-factory';
