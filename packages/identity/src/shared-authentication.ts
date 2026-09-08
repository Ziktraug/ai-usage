import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthenticationIdentityId, Instant, PersonId, WebSessionId } from '@ai-usage/platform-core/identity';
import {
  parseAuthenticationIdentityId,
  parseInstant,
  parsePersonId,
  parseWebSessionId,
} from '@ai-usage/platform-core/identity';
import { APIError, betterAuth, type DBAdapter, type DBAdapterInstance, type DBTransactionAdapter } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { IdentityServiceResult, SharedAuthenticationPrincipal, SharedSessionResolution } from './index';
import { SHARED_AUTHENTICATION_PROVIDER } from './index';
import { getInjectedSharedAuthenticationServiceFactory } from './internal/shared-authentication-factory';
import { withWebSessionTokenDigests } from './session-digest-adapter';

/**
 * SQLSTATEs raised by the PostgreSQL guards on `authentication_provider_accounts`:
 * `authentication_provider_accounts_keep_last` (migration ordinal 9) when a
 * delete would remove a principal's last provider account, and
 * `authentication_provider_accounts_refuse_revoked` (ordinal 10) when an insert
 * would relink an unlinked identity. The triggers are what make both invariants
 * hold under concurrent requests; the application-level checks around them are
 * only fast paths, so their refusals surface as the same typed responses.
 */
const LAST_PROVIDER_ACCOUNT_SQLSTATE = 'IA001';
const REVOKED_IDENTITY_RELINK_SQLSTATE = 'IA002';
const MAXIMUM_ERROR_CAUSE_DEPTH = 4;

const hasSqlState = (error: unknown, sqlState: string): boolean => {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAXIMUM_ERROR_CAUSE_DEPTH && typeof current === 'object' && current !== null;
    depth += 1
  ) {
    if ('code' in current && current.code === sqlState) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};

// Identical to Better Auth's own `FAILED_TO_UNLINK_LAST_ACCOUNT` refusal, which
// its unlink endpoint raises when the pre-check already sees a single account.
const lastProviderAccountRefusal = (): APIError =>
  new APIError('BAD_REQUEST', {
    code: 'FAILED_TO_UNLINK_LAST_ACCOUNT',
    message: "You can't unlink your last account",
  });

// An unlinked identity cannot be linked again; there is no relink authority yet.
const revokedIdentityRefusal = (): APIError =>
  new APIError('BAD_REQUEST', {
    code: 'IDENTITY_REVOKED',
    message: 'This identity was unlinked and cannot be linked again.',
  });

const guardAccountWrites = <Adapter extends DBTransactionAdapter>(adapter: Adapter): Adapter => ({
  ...adapter,
  create: async <T extends Record<string, unknown>, R = T>(input: {
    readonly data: Omit<T, 'id'>;
    readonly forceAllowId?: boolean | undefined;
    readonly model: string;
    readonly select?: string[] | undefined;
  }): Promise<R> => {
    try {
      return await adapter.create<T, R>(input);
    } catch (error) {
      throw input.model === 'account' && hasSqlState(error, REVOKED_IDENTITY_RELINK_SQLSTATE)
        ? revokedIdentityRefusal()
        : error;
    }
  },
  delete: async (input: Parameters<DBTransactionAdapter['delete']>[0]): Promise<void> => {
    try {
      await adapter.delete(input);
    } catch (error) {
      throw input.model === 'account' && hasSqlState(error, LAST_PROVIDER_ACCOUNT_SQLSTATE)
        ? lastProviderAccountRefusal()
        : error;
    }
  },
  deleteMany: async (input: Parameters<DBTransactionAdapter['deleteMany']>[0]): Promise<number> => {
    try {
      return await adapter.deleteMany(input);
    } catch (error) {
      throw input.model === 'account' && hasSqlState(error, LAST_PROVIDER_ACCOUNT_SQLSTATE)
        ? lastProviderAccountRefusal()
        : error;
    }
  },
});

const withProviderAccountGuards =
  (database: DBAdapterInstance): DBAdapterInstance =>
  (options) => {
    const adapter = database(options);
    const result: DBAdapter = {
      ...guardAccountWrites(adapter),
      id: `${adapter.id}-provider-account-guards`,
      transaction: (run) => adapter.transaction((transaction) => run(guardAccountWrites(transaction))),
    };
    return result;
  };

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
  /** Whether a provider subject maps to an unlinked (revoked) identity, on any principal. */
  readonly hasRevokedAuthenticationIdentity: (providerSubject: string) => Promise<IdentityServiceResult<boolean>>;
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

// Every allowed route that mutates the account on behalf of a Web session. The
// application resolver, not only Better Auth's session lookup, must accept the
// session first: a session whose identity was revoked, or whose Person is no
// longer active, still exists as a Better Auth session row. Sign-out is left
// out on purpose so a refused session can still be ended by its holder.
const sessionAuthenticatedPaths = new Set(['/link-social', '/revoke-sessions', '/unlink-account']);

// Better Auth's own vocabulary for a session that must re-authenticate.
const revokedSessionRefusal = (): APIError =>
  new APIError('UNAUTHORIZED', {
    code: 'SESSION_EXPIRED',
    message: 'Session expired. Re-authenticate to perform this action.',
  });

interface ResolvedWebSession {
  readonly authenticationPrincipalId: string | null;
  readonly resolution: SharedSessionResolution;
}

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
  const requestAuthentication = new AsyncLocalStorage<{ readonly headers: Headers; providerSubject?: string }>();
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
  const resolveWebSession = async (headers: Headers): Promise<ResolvedWebSession> => {
    try {
      const resolved = await auth.api.getSession({ headers });
      if (!resolved) {
        return { authenticationPrincipalId: null, resolution: { kind: 'anonymous' } };
      }
      const authenticationPrincipalId = resolved.user.id;
      const session = resolved.session as typeof resolved.session & Record<string, unknown>;
      if (session.revokedAt !== null && session.revokedAt !== undefined) {
        return { authenticationPrincipalId, resolution: { kind: 'revoked' } };
      }
      const absoluteExpiresAt = instantFromDateValue(session.absoluteExpiresAt, 'webSession.absoluteExpiresAt');
      const idleExpiresAt = instantFromDateValue(session.expiresAt, 'webSession.idleExpiresAt');
      const currentTime = clock().getTime();
      if (Date.parse(absoluteExpiresAt) <= currentTime || Date.parse(idleExpiresAt) <= currentTime) {
        return { authenticationPrincipalId, resolution: { kind: 'expired' } };
      }
      const authenticationIdentityId = parseAuthenticationIdentityId(session.authenticationIdentityId);
      const principal = await config.identityStore.resolveAuthenticationIdentity(authenticationIdentityId);
      if (!principal) {
        return { authenticationPrincipalId, resolution: { kind: 'revoked' } };
      }
      return {
        authenticationPrincipalId,
        resolution: {
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
        },
      };
    } catch {
      return { authenticationPrincipalId: null, resolution: { kind: 'unavailable' } };
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
    database: withProviderAccountGuards(withWebSessionTokenDigests(config.database)),
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
          // Implicit linking is disabled, so an account created for a principal
          // that already has one is an explicit link completing at the OAuth
          // callback. The callback carries the link in its state, not in a
          // session check, so the session that started the link is re-validated
          // here: a session revoked in the meantime cannot add a new identity.
          before: async (
            account: { readonly accountId: string; readonly userId: string },
            context?: {
              readonly context: {
                readonly internalAdapter: {
                  readonly findAccounts: (userId: string) => Promise<readonly unknown[]>;
                };
              };
            } | null,
          ): Promise<void> => {
            const existing = (await context?.context.internalAdapter.findAccounts(account.userId)) ?? [];
            if (existing.length === 0) {
              return;
            }
            const headers = requestAuthentication.getStore()?.headers;
            const resolved = headers ? await resolveWebSession(headers) : null;
            if (
              resolved?.resolution.kind !== 'authenticated' ||
              resolved.authenticationPrincipalId !== account.userId
            ) {
              throw revokedSessionRefusal();
            }
            // An unlinked identity stays as a revoked row. Synchronization refuses
            // any principal owning a provider account that maps to one, and Better
            // Auth cannot undo the account insertion afterwards, so the relink is
            // refused here, before the row exists, instead of orphaning it.
            const revoked = await config.identityStore.hasRevokedAuthenticationIdentity(account.accountId);
            if (revoked.kind === 'error') {
              throw new AuthenticationRejectedError();
            }
            if (revoked.value) {
              throw revokedIdentityRefusal();
            }
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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!sessionAuthenticatedPaths.has(ctx.path)) {
          return;
        }
        const { resolution } = await resolveWebSession(ctx.headers ?? new Headers());
        if (resolution.kind === 'revoked' || resolution.kind === 'expired') {
          throw revokedSessionRefusal();
        }
      }),
    },
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
        ? requestAuthentication.run({ headers: request.headers }, () => auth.handler(request))
        : Promise.resolve(new Response('Not Found', { status: 404 }));
    },
    resolveSession: async (headers) => (await resolveWebSession(headers)).resolution,
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
