import type { SharedAuthenticationDatabase, SharedAuthenticationIdentityStore } from '@ai-usage/identity/better-auth';

export interface PlatformAuthenticationStore extends SharedAuthenticationIdentityStore {
  readonly database: SharedAuthenticationDatabase;
}
