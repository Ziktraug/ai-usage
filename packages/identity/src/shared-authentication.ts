import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthenticationIdentityId, Instant, PersonId, WebSessionId } from '@ai-usage/platform-core/identity';
import {
  parseAuthenticationIdentityId,
  parseInstant,
  parsePersonId,
  parseWebSessionId,
} from '@ai-usage/platform-core/identity';
import { betterAuth, type DBAdapterInstance } from 'better-auth';
import type { IdentityServiceResult, SharedAuthenticationPrincipal, SharedSessionResolution } from './index';
import { SHARED_AUTHENTICATION_PROVIDER } from './index';
import { getInjectedSharedAuthenticationServiceFactory } from './internal/shared-authentication-factory';
import { withWebSessionTokenDigests } from './session-digest-adapter';

export const BETTER_AUTH_VERSION = '1.7.2' as const;
export const SHARED_SESSION_ABSOLUTE_LIFETIME_SECONDS = 24 * 60 * 60;
export const SHARED_SESSION_FRESH_LIFETIME_SECONDS = 15 * 60;

export type SharedAuthenticationDatabase = DBAdapterInstance;

export interface SynchronizeAuthenticationPrincipalInput {
  readonly authenticationPrincipalId: string;
  readonly bootstrapFirstOwner: boolean;
  readonly observedAt: Instant;
  readonly preferredProviderSubject?: string;
}

export interface SharedAuthenticationIdentityStore {
  readonly canUnlinkAuthenticationIdentity: (input: {
    readonly authenticationPrincipalId: string;
    readonly providerSubject: string;
  }) => Promise<boolean>;
  readonly recordAuthenticationEvent: (input: {
    readonly authenticationIdentityId: AuthenticationIdentityId;
    readonly authenticationPrincipalId: string;
    readonly eventType: 'shared-login-succeeded' | 'web-session-revoked';
    readonly observedAt: Instant;
    readonly webSessionId: WebSessionId;
  }) => Promise<IdentityServiceResult<undefined>>;
  readonly resolveAuthenticationIdentity: (
    authenticationIdentityId: AuthenticationIdentityId,
  ) => Promise<SharedAuthenticationPrincipal | null>;
  readonly revokeAuthenticationIdentity: (input: {
    readonly authenticationPrincipalId: string;
    readonly providerSubject: string;
    readonly revokedAt: Instant;
  }) => Promise<IdentityServiceResult<undefined>>;
  readonly synchronizeAuthenticationPrincipal: (
    input: SynchronizeAuthenticationPrincipalInput,
  ) => Promise<IdentityServiceResult<SharedAuthenticationPrincipal>>;
}

export interface SharedAuthenticationServiceConfig {
  readonly baseUrl: string;
  readonly bootstrapFirstOwner: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clock?: () => Date;
  readonly database: SharedAuthenticationDatabase;
  readonly identityStore: SharedAuthenticationIdentityStore;
  readonly secrets: readonly { readonly value: string; readonly version: number }[];
}

export interface SharedAuthenticationService {
  readonly handle: (request: Request) => Promise<Response>;
  readonly resolveSession: (headers: Headers) => Promise<SharedSessionResolution>;
  readonly revokeAllSessions: (headers: Headers) => Promise<IdentityServiceResult<undefined>>;
}

class AuthenticationRejectedError extends Error {
  constructor() {
    super('Shared authentication was rejected.');
    this.name = 'AuthenticationRejectedError';
  }
}

const instantFromDateValue = (value: unknown, field: string): Instant => {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    date = new Date(value);
  }
  if (!(date && Number.isFinite(date.getTime()))) {
    throw new AuthenticationRejectedError();
  }
  return parseInstant(date.toISOString(), field);
};

const allowedAuthenticationPaths = new Set([
  '/api/auth/callback/github',
  '/api/auth/error',
  '/api/auth/link-social',
  '/api/auth/revoke-sessions',
  '/api/auth/sign-in/social',
  '/api/auth/sign-out',
  '/api/auth/unlink-account',
]);

const parseAuthenticationBaseUrl = (value: string): URL => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new AuthenticationRejectedError();
    }
    return url;
  } catch {
    throw new AuthenticationRejectedError();
  }
};

const validateSecrets = (secrets: SharedAuthenticationServiceConfig['secrets']): void => {
  if (
    secrets.length === 0 ||
    secrets.some(
      (secret, index) =>
        secret.value.length < 32 ||
        !Number.isSafeInteger(secret.version) ||
        secret.version <= 0 ||
        secrets.findIndex((candidate) => candidate.version === secret.version) !== index,
    )
  ) {
    throw new AuthenticationRejectedError();
  }
};

const asPersonId = (value: unknown): PersonId => parsePersonId(value);

export const createSharedAuthenticationService = (
  config: SharedAuthenticationServiceConfig,
): SharedAuthenticationService => {
  const injectedFactory = getInjectedSharedAuthenticationServiceFactory();
  if (injectedFactory) {
    return injectedFactory(config);
  }
  const baseUrl = parseAuthenticationBaseUrl(config.baseUrl);
  validateSecrets(config.secrets);
  if (config.clientId.length === 0 || config.clientSecret.length === 0) {
    throw new AuthenticationRejectedError();
  }
  const clock = config.clock ?? (() => new Date());
  const secureCookies = baseUrl.protocol === 'https:';
  const requestAuthentication = new AsyncLocalStorage<{ providerSubject?: string }>();
  const synchronize = async (authenticationPrincipalId: string, preferredProviderSubject?: string) => {
    const result = await config.identityStore.synchronizeAuthenticationPrincipal({
      authenticationPrincipalId,
      bootstrapFirstOwner: config.bootstrapFirstOwner,
      observedAt: parseInstant(clock().toISOString()),
      ...(preferredProviderSubject === undefined ? {} : { preferredProviderSubject }),
    });
    if (result.kind === 'error') {
      throw new AuthenticationRejectedError();
    }
    return result.value;
  };
  const recordSessionEvent = async (
    session: { readonly id: string; readonly userId: string } & Record<string, unknown>,
    eventType: 'shared-login-succeeded' | 'web-session-revoked',
  ): Promise<void> => {
    const recorded = await config.identityStore.recordAuthenticationEvent({
      authenticationIdentityId: parseAuthenticationIdentityId(session.authenticationIdentityId),
      authenticationPrincipalId: session.userId,
      eventType,
      observedAt: parseInstant(clock().toISOString()),
      webSessionId: parseWebSessionId(session.id),
    });
    if (recorded.kind === 'error') {
      throw new AuthenticationRejectedError();
    }
  };

  const options = {
    account: {
      accountLinking: {
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
        enabled: true,
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
      fields: {
        accessToken: 'accessToken',
        accessTokenExpiresAt: 'accessTokenExpiresAt',
        accountId: 'accountId',
        createdAt: 'createdAt',
        idToken: 'idToken',
        issuer: 'issuer',
        password: 'password',
        providerId: 'providerId',
        refreshToken: 'refreshToken',
        refreshTokenExpiresAt: 'refreshTokenExpiresAt',
        scope: 'scope',
        updatedAt: 'updatedAt',
        userId: 'userId',
      },
      modelName: 'authenticationProviderAccount',
      storeStateStrategy: 'database' as const,
    },
    advanced: {
      cookiePrefix: secureCookies ? '__Host-ai-usage' : 'ai-usage-dev',
      cookies: secureCookies
        ? {
            account_data: { name: '__Host-ai-usage-account-data' },
            dont_remember: { name: '__Host-ai-usage-dont-remember' },
            oauth_state: { name: '__Host-ai-usage-oauth-state' },
            session_data: { name: '__Host-ai-usage-session-data' },
            session_token: { name: '__Host-ai-usage-session' },
            state: { name: '__Host-ai-usage-state' },
          }
        : undefined,
      crossSubDomainCookies: { enabled: false },
      database: { generateId: 'uuid' as const, joins: false },
      defaultCookieAttributes: {
        httpOnly: true,
        path: '/',
        sameSite: 'lax' as const,
        secure: secureCookies,
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { disableIpTracking: true },
      useSecureCookies: false,
    },
    appName: 'ai-usage',
    basePath: '/api/auth',
    baseURL: baseUrl.origin,
    database: withWebSessionTokenDigests(config.database),
    databaseHooks: {
      account: {
        create: {
          after: async (account: {
            readonly accountId: string;
            readonly providerId: string;
            readonly userId: string;
          }): Promise<void> => {
            if (account.providerId !== SHARED_AUTHENTICATION_PROVIDER) {
              throw new AuthenticationRejectedError();
            }
            const authentication = requestAuthentication.getStore();
            if (authentication) {
              authentication.providerSubject = account.accountId;
            }
            await synchronize(account.userId, account.accountId);
          },
        },
        delete: {
          after: async (account: { readonly accountId: string; readonly userId: string }): Promise<void> => {
            const revoked = await config.identityStore.revokeAuthenticationIdentity({
              authenticationPrincipalId: account.userId,
              providerSubject: account.accountId,
              revokedAt: parseInstant(clock().toISOString()),
            });
            if (revoked.kind === 'error') {
              throw new AuthenticationRejectedError();
            }
          },
          before: async (account: { readonly accountId: string; readonly userId: string }): Promise<boolean> =>
            config.identityStore.canUnlinkAuthenticationIdentity({
              authenticationPrincipalId: account.userId,
              providerSubject: account.accountId,
            }),
        },
        update: {
          after: (account: { readonly accountId: string; readonly providerId: string }): Promise<void> => {
            if (account.providerId !== SHARED_AUTHENTICATION_PROVIDER) {
              throw new AuthenticationRejectedError();
            }
            const authentication = requestAuthentication.getStore();
            if (authentication) {
              authentication.providerSubject = account.accountId;
            }
            return Promise.resolve();
          },
        },
      },
      session: {
        create: {
          after: async (
            session: { readonly id: string; readonly userId: string } & Record<string, unknown>,
          ): Promise<void> => recordSessionEvent(session, 'shared-login-succeeded'),
          before: async (session: { readonly createdAt: Date; readonly expiresAt: Date; readonly userId: string }) => {
            const principal = await synchronize(session.userId, requestAuthentication.getStore()?.providerSubject);
            const absoluteExpiresAt = new Date(
              Math.min(
                session.expiresAt.getTime(),
                session.createdAt.getTime() + SHARED_SESSION_ABSOLUTE_LIFETIME_SECONDS * 1000,
              ),
            );
            const freshUntil = new Date(
              Math.min(
                absoluteExpiresAt.getTime(),
                session.createdAt.getTime() + SHARED_SESSION_FRESH_LIFETIME_SECONDS * 1000,
              ),
            );
            return {
              data: {
                ...session,
                absoluteExpiresAt,
                authenticationIdentityId: principal.authenticationIdentityId,
                expiresAt: absoluteExpiresAt,
                freshUntil,
                ipAddress: '',
                revokedAt: null,
                userAgent: '',
              },
            };
          },
        },
        delete: {
          after: async (
            session: { readonly id: string; readonly userId: string } & Record<string, unknown>,
          ): Promise<void> => recordSessionEvent(session, 'web-session-revoked'),
        },
      },
    },
    disabledPaths: [
      '/change-email',
      '/change-password',
      '/delete-user',
      '/forget-password',
      '/get-session',
      '/list-accounts',
      '/list-sessions',
      '/revoke-other-sessions',
      '/revoke-session',
      '/set-password',
      '/sign-in/email',
      '/sign-up/email',
      '/update-user',
    ],
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    onAPIError: { throw: false },
    secrets: config.secrets.map((secret) => ({ value: secret.value, version: secret.version })),
    session: {
      additionalFields: {
        absoluteExpiresAt: { input: false, required: true, type: 'date' as const },
        authenticationIdentityId: { input: false, required: true, type: 'string' as const },
        freshUntil: { input: false, required: true, type: 'date' as const },
        revokedAt: { input: false, required: false, type: 'date' as const },
      },
      disableSessionRefresh: true,
      expiresIn: SHARED_SESSION_ABSOLUTE_LIFETIME_SECONDS,
      fields: {
        createdAt: 'createdAt',
        expiresAt: 'expiresAt',
        ipAddress: 'ipAddress',
        token: 'tokenDigest',
        updatedAt: 'updatedAt',
        userAgent: 'userAgent',
        userId: 'userId',
      },
      freshAge: SHARED_SESSION_FRESH_LIFETIME_SECONDS,
      modelName: 'webSession',
      updateAge: 0,
    },
    socialProviders: {
      github: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        disableDefaultScope: true,
        mapProfileToUser: (profile: { readonly id: string }) => ({
          email: `${profile.id}@github.auth.ai-usage.invalid`,
          emailVerified: true,
        }),
        scope: ['read:user', 'user:email'],
      },
    },
    telemetry: { enabled: false },
    trustedOrigins: [baseUrl.origin],
    user: {
      fields: {
        createdAt: 'createdAt',
        email: 'email',
        emailVerified: 'emailVerified',
        image: 'image',
        name: 'name',
        updatedAt: 'updatedAt',
      },
      modelName: 'authenticationPrincipal',
    },
    verification: {
      fields: {
        createdAt: 'createdAt',
        expiresAt: 'expiresAt',
        identifier: 'identifier',
        updatedAt: 'updatedAt',
        value: 'value',
      },
      modelName: 'authenticationVerification',
    },
  };
  const auth = betterAuth(options);

  const service: SharedAuthenticationService = {
    handle: (request) => {
      const path = new URL(request.url).pathname;
      return allowedAuthenticationPaths.has(path)
        ? requestAuthentication.run({}, () => auth.handler(request))
        : Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    resolveSession: async (headers) => {
      try {
        const resolved = await auth.api.getSession({ headers });
        if (!resolved) {
          return { kind: 'anonymous' };
        }
        const session = resolved.session as typeof resolved.session & Record<string, unknown>;
        if (session.revokedAt !== null && session.revokedAt !== undefined) {
          return { kind: 'revoked' };
        }
        const absoluteExpiresAt = instantFromDateValue(session.absoluteExpiresAt, 'webSession.absoluteExpiresAt');
        const idleExpiresAt = instantFromDateValue(session.expiresAt, 'webSession.idleExpiresAt');
        const currentTime = clock().getTime();
        if (Date.parse(absoluteExpiresAt) <= currentTime || Date.parse(idleExpiresAt) <= currentTime) {
          return { kind: 'expired' };
        }
        const authenticationIdentityId = parseAuthenticationIdentityId(session.authenticationIdentityId);
        const principal = await config.identityStore.resolveAuthenticationIdentity(authenticationIdentityId);
        if (!principal) {
          return { kind: 'revoked' };
        }
        return {
          kind: 'authenticated',
          session: {
            absoluteExpiresAt,
            createdAt: instantFromDateValue(session.createdAt, 'webSession.createdAt'),
            freshUntil: instantFromDateValue(session.freshUntil, 'webSession.freshUntil'),
            id: parseWebSessionId(session.id),
            idleExpiresAt,
            principal: {
              ...principal,
              personId: asPersonId(principal.personId),
              provider: SHARED_AUTHENTICATION_PROVIDER,
            },
          },
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    revokeAllSessions: async (headers) => {
      try {
        await auth.api.revokeSessions({ headers });
        return { kind: 'success', value: undefined };
      } catch {
        return {
          error: { code: 'identity-unavailable', operation: 'revoke-all-sessions' },
          kind: 'error',
        };
      }
    },
  };
  return Object.freeze(service);
};
