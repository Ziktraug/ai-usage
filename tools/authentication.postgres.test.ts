import { describe, expect, test } from 'bun:test';
import { createSharedAuthenticationService } from '@ai-usage/identity/better-auth';
import { parseAuthenticationIdentityId, parseInstant } from '@ai-usage/platform-core/identity';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { Pool } from 'pg';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const baseUrl = 'https://platform.example.invalid';
const httpOnlyCookiePattern = /; HttpOnly/iu;
const secureCookiePattern = /; Secure/iu;
const sameSiteLaxCookiePattern = /; SameSite=Lax/iu;
const cookiePathPattern = /; Path=\//iu;
const cookieDomainPattern = /; Domain=/iu;
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;

const fetchInputUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
};

const getSetCookies = (response: Response): readonly string[] => {
  const headers = response.headers as Headers & { readonly getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter((value): value is string => !!value);
};

const cookieHeader = (cookies: readonly string[]): string =>
  cookies.map((cookie) => cookie.slice(0, cookie.indexOf(';'))).join('; ');

const postJson = (path: string, body: unknown, cookie?: string): Request =>
  new Request(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
    },
    method: 'POST',
  });

/**
 * Drives a complete GitHub OAuth round trip (sign-in or link) against a
 * controlled provider whose subject is `subject.current`, and returns the
 * Web-session cookie header the callback set (or the cookie that was passed in).
 */
const createOAuthFlow = (
  service: ReturnType<typeof createSharedAuthenticationService>,
  subject: { current: string },
) => {
  const originalFetch = globalThis.fetch;
  const mockedFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = fetchInputUrl(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(
        Response.json({ access_token: 'provider-token', scope: 'read:user,user:email', token_type: 'bearer' }),
      );
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        Response.json({
          avatar_url: 'https://avatars.example.invalid/1',
          email: null,
          id: subject.current,
          login: 'stable-login',
          name: 'Stable Person',
        }),
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      return Promise.resolve(
        Response.json([{ email: 'same-email@example.invalid', primary: true, verified: true, visibility: null }]),
      );
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = Object.assign(mockedFetch, { preconnect: originalFetch.preconnect });
  const start = async (path: '/api/auth/link-social' | '/api/auth/sign-in/social', cookie?: string) => {
    const started = await service.handle(
      postJson(path, { callbackURL: `${baseUrl}/done`, disableRedirect: true, provider: 'github' }, cookie),
    );
    if (started.status !== 200) {
      return { started, state: null };
    }
    const state = new URL(((await started.json()) as { readonly url: string }).url).searchParams.get('state');
    return { started, state };
  };
  const callback = (state: string, cookies: readonly (string | undefined)[]) =>
    service.handle(
      new Request(`${baseUrl}/api/auth/callback/github?code=code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookies.filter((value): value is string => !!value).join('; ') },
      }),
    );
  const complete = async (path: '/api/auth/link-social' | '/api/auth/sign-in/social', cookie?: string) => {
    const { started, state } = await start(path, cookie);
    if (!state) {
      throw new Error(`Expected ${path} to answer 200 with an OAuth state, received ${started.status}.`);
    }
    const completed = await callback(state, [cookie, cookieHeader(getSetCookies(started))]);
    const location = completed.headers.get('location');
    if (completed.status !== 302 || location !== `${baseUrl}/done`) {
      throw new Error(`Expected the ${path} callback to redirect to /done, received ${completed.status} ${location}.`);
    }
    const sessionCookie = getSetCookies(completed).find((value) => value.startsWith('__Host-ai-usage-session='));
    return sessionCookie ? cookieHeader([sessionCookie]) : cookie;
  };
  return {
    callback,
    complete,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
    start,
  };
};

if (runPostgresTests) {
  describe('PostgreSQL shared authentication', () => {
    test('boots the first GitHub owner through secure OAuth and stores only a Web-session digest', async () => {
      const cluster = await startPostgresCluster('shared-authentication');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      const service = createSharedAuthenticationService({
        baseUrl,
        bootstrapFirstOwner: true,
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
        database: store.authentication.database,
        identityStore: store.authentication,
        secrets: [{ value: 'auth-secret-with-more-than-thirty-two-characters-v1', version: 1 }],
      });
      const providerAccessToken = 'provider-token-must-never-leak';
      let providerSubject = '123456';
      const originalFetch = globalThis.fetch;
      try {
        const signIn = await service.handle(
          postJson('/api/auth/sign-in/social', {
            callbackURL: `${baseUrl}/after`,
            disableRedirect: true,
            provider: 'github',
          }),
        );
        expect(signIn.status).toBe(200);
        const signInBody = (await signIn.json()) as { readonly redirect: boolean; readonly url: string };
        const authorizationUrl = new URL(signInBody.url);
        expect(authorizationUrl.origin).toBe('https://github.com');
        expect(authorizationUrl.searchParams.get('scope')).toBe('read:user user:email');
        expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
        const state = authorizationUrl.searchParams.get('state');
        if (!state) {
          throw new Error('Expected an OAuth state value.');
        }
        const stateCookies = getSetCookies(signIn);
        for (const cookie of stateCookies) {
          expect(cookie).toMatch(httpOnlyCookiePattern);
          expect(cookie).toMatch(secureCookiePattern);
          expect(cookie).toMatch(sameSiteLaxCookiePattern);
          expect(cookie).toMatch(cookiePathPattern);
          expect(cookie).not.toMatch(cookieDomainPattern);
        }

        const mockedFetch = (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ): Promise<Response> => {
          const url = fetchInputUrl(input);
          if (url === 'https://github.com/login/oauth/access_token') {
            return Promise.resolve(
              Response.json({
                access_token: providerAccessToken,
                scope: 'read:user,user:email',
                token_type: 'bearer',
              }),
            );
          }
          if (url === 'https://api.github.com/user') {
            return Promise.resolve(
              Response.json({
                avatar_url: 'https://avatars.example.invalid/1',
                email: null,
                id: providerSubject,
                login: 'stable-login',
                name: 'Stable Person',
              }),
            );
          }
          if (url === 'https://api.github.com/user/emails') {
            return Promise.resolve(
              Response.json([{ email: 'same-email@example.invalid', primary: true, verified: true, visibility: null }]),
            );
          }
          return originalFetch(input, init);
        };
        globalThis.fetch = Object.assign(mockedFetch, { preconnect: originalFetch.preconnect });

        const callback = await service.handle(
          new Request(`${baseUrl}/api/auth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}`, {
            headers: { cookie: cookieHeader(stateCookies) },
          }),
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toBe(`${baseUrl}/after`);
        expect(await callback.clone().text()).not.toContain(providerAccessToken);
        expect(JSON.stringify([...callback.headers])).not.toContain(providerAccessToken);

        const sessionCookies = getSetCookies(callback);
        const sessionCookie = sessionCookies.find((cookie) => cookie.startsWith('__Host-ai-usage-session='));
        if (!sessionCookie) {
          throw new Error('Expected the secure Web-session cookie.');
        }
        expect(sessionCookie).toMatch(httpOnlyCookiePattern);
        expect(sessionCookie).toMatch(secureCookiePattern);
        expect(sessionCookie).toMatch(sameSiteLaxCookiePattern);
        expect(sessionCookie).not.toMatch(cookieDomainPattern);
        const sessionCookieHeader = cookieHeader([sessionCookie]);
        await expect(service.resolveSession(new Headers({ cookie: sessionCookieHeader }))).resolves.toMatchObject({
          kind: 'authenticated',
          session: { principal: { personId: expect.any(String), provider: 'github' } },
        });
        await expect(
          service.handle(new Request(`${baseUrl}/api/auth/get-session`, { headers: { cookie: sessionCookieHeader } })),
        ).resolves.toMatchObject({ status: 404 });

        const counts = await pool.query<{
          readonly accounts: number;
          readonly bootstrap: number;
          readonly identities: number;
          readonly people: number;
          readonly sessions: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_provider_accounts) AS accounts,
          (SELECT count(*)::INTEGER FROM platform_bootstrap_state) AS bootstrap,
          (SELECT count(*)::INTEGER FROM authentication_identities) AS identities,
          (SELECT count(*)::INTEGER FROM people) AS people,
          (SELECT count(*)::INTEGER FROM web_sessions) AS sessions`);
        expect(counts.rows[0]).toEqual({ accounts: 1, bootstrap: 1, identities: 1, people: 1, sessions: 1 });

        const loginAudit = await pool.query<{
          readonly authentication_identity_id: string;
          readonly subject_id: string;
          readonly subject_type: string;
        }>(`SELECT identity.id AS authentication_identity_id, event.subject_id, event.subject_type
            FROM identity_events event
            INNER JOIN authentication_identities identity ON identity.id = event.subject_id
            WHERE event.event_type = 'shared-login-succeeded'
            ORDER BY event.recorded_at ASC
            LIMIT 1`);
        const loginAuditRow = loginAudit.rows[0];
        if (!loginAuditRow) {
          throw new Error('Expected a shared-login identity audit event.');
        }
        expect(loginAuditRow).toEqual({
          authentication_identity_id: loginAuditRow.authentication_identity_id,
          subject_id: loginAuditRow.authentication_identity_id,
          subject_type: 'authentication-identity',
        });

        const persisted = await pool.query<{
          readonly absolute_lifetime_seconds: number;
          readonly access_token: string;
          readonly email: string;
          readonly fresh_lifetime_seconds: number;
          readonly idle_lifetime_seconds: number;
          readonly ip_address: string;
          readonly token_digest: string;
          readonly user_agent: string;
        }>(`SELECT account.access_token, principal.email, session.ip_address,
                  session.token_digest, session.user_agent,
                  EXTRACT(EPOCH FROM (session.absolute_expires_at - session.created_at))::INTEGER
                    AS absolute_lifetime_seconds,
                  EXTRACT(EPOCH FROM (session.fresh_until - session.created_at))::INTEGER
                    AS fresh_lifetime_seconds,
                  EXTRACT(EPOCH FROM (session.expires_at - session.created_at))::INTEGER
                    AS idle_lifetime_seconds
           FROM authentication_provider_accounts account
           INNER JOIN authentication_principals principal ON principal.id = account.user_id
           INNER JOIN web_sessions session ON session.user_id = principal.id`);
        const row = persisted.rows[0];
        if (!row) {
          throw new Error('Expected persisted authentication rows.');
        }
        expect(row.email).toBe('123456@github.auth.ai-usage.invalid');
        expect(row.access_token).not.toBe(providerAccessToken);
        expect(row.access_token).not.toContain(providerAccessToken);
        expect(row.token_digest).toMatch(digestPattern);
        expect(sessionCookie).not.toContain(row.token_digest);
        expect(row.ip_address).toBe('');
        expect(row.user_agent).toBe('');
        expect(row.absolute_lifetime_seconds).toBe(86_400);
        expect(row.idle_lifetime_seconds).toBe(86_400);
        expect(row.fresh_lifetime_seconds).toBe(900);
        expect(
          (
            await service.handle(
              new Request(`${baseUrl}/api/auth/link-social`, {
                body: JSON.stringify({ provider: 'github' }),
                headers: {
                  'content-type': 'application/json',
                  cookie: sessionCookieHeader,
                  origin: 'https://attacker.example.invalid',
                },
                method: 'POST',
              }),
            )
          ).status,
        ).toBe(403);

        const signInAsCurrentProvider = async (callbackPath: string): Promise<string> => {
          const signInAgain = await service.handle(
            postJson('/api/auth/sign-in/social', {
              callbackURL: `${baseUrl}${callbackPath}`,
              disableRedirect: true,
              provider: 'github',
            }),
          );
          expect(signInAgain.status).toBe(200);
          const signInAgainBody = (await signInAgain.json()) as { readonly url: string };
          const signInAgainState = new URL(signInAgainBody.url).searchParams.get('state');
          if (!signInAgainState) {
            throw new Error('Expected a repeated OAuth state value.');
          }
          const signedInAgain = await service.handle(
            new Request(
              `${baseUrl}/api/auth/callback/github?code=repeated-code&state=${encodeURIComponent(signInAgainState)}`,
              { headers: { cookie: cookieHeader(getSetCookies(signInAgain)) } },
            ),
          );
          expect(signedInAgain.status).toBe(302);
          expect(signedInAgain.headers.get('location')).toBe(`${baseUrl}${callbackPath}`);
          const repeatedSessionCookie = getSetCookies(signedInAgain).find((cookie) =>
            cookie.startsWith('__Host-ai-usage-session='),
          );
          if (!repeatedSessionCookie) {
            throw new Error('Expected a rotated Web-session cookie.');
          }
          return cookieHeader([repeatedSessionCookie]);
        };

        const link = await service.handle(
          postJson(
            '/api/auth/link-social',
            { callbackURL: `${baseUrl}/linked`, disableRedirect: true, provider: 'github' },
            sessionCookieHeader,
          ),
        );
        expect(link.status).toBe(200);
        const linkBody = (await link.json()) as { readonly url: string };
        const linkState = new URL(linkBody.url).searchParams.get('state');
        if (!linkState) {
          throw new Error('Expected an explicit account-linking state value.');
        }
        providerSubject = '789012';
        const linkCallback = await service.handle(
          new Request(`${baseUrl}/api/auth/callback/github?code=link-code&state=${encodeURIComponent(linkState)}`, {
            headers: { cookie: cookieHeader([sessionCookie, ...getSetCookies(link)]) },
          }),
        );
        expect(linkCallback.status).toBe(302);
        expect(linkCallback.headers.get('location')).toBe(`${baseUrl}/linked`);
        const linkedCounts = await pool.query<{
          readonly accounts: number;
          readonly identities: number;
          readonly people: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_provider_accounts) AS accounts,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NULL) AS identities,
          (SELECT count(*)::INTEGER FROM people) AS people`);
        expect(linkedCounts.rows[0]).toEqual({ accounts: 2, identities: 2, people: 1 });
        await expect(service.resolveSession(new Headers({ cookie: sessionCookieHeader }))).resolves.toEqual({
          kind: 'anonymous',
        });

        const linkedAccount = await pool.query<{ readonly id: string; readonly identity_id: string }>(
          `SELECT account.id, identity.id AS identity_id
           FROM authentication_provider_accounts account
           INNER JOIN authentication_identities identity
             ON identity.authentication_provider_account_id = account.id
           WHERE account.account_id = $1`,
          [providerSubject],
        );
        const linkedAccountId = linkedAccount.rows[0]?.id;
        const linkedIdentityId = linkedAccount.rows[0]?.identity_id;
        if (!(linkedAccountId && linkedIdentityId)) {
          throw new Error('Expected the explicitly linked GitHub account.');
        }
        const linkedSessionCookieHeader = await signInAsCurrentProvider('/after-link-reauthentication');
        await expect(service.resolveSession(new Headers({ cookie: linkedSessionCookieHeader }))).resolves.toMatchObject(
          {
            kind: 'authenticated',
            session: { principal: { authenticationIdentityId: linkedIdentityId } },
          },
        );
        const unlink = await service.handle(
          postJson('/api/auth/unlink-account', { accountId: linkedAccountId }, linkedSessionCookieHeader),
        );
        expect(unlink.status).toBe(200);
        const unlinked = await pool.query<{
          readonly active: number;
          readonly revoked: number;
        }>(`SELECT
          count(*) FILTER (WHERE revoked_at IS NULL)::INTEGER AS active,
          count(*) FILTER (WHERE revoked_at IS NOT NULL)::INTEGER AS revoked
          FROM authentication_identities`);
        expect(unlinked.rows[0]).toEqual({ active: 1, revoked: 1 });

        const lastAccount = await pool.query<{ readonly id: string }>(
          'SELECT id FROM authentication_provider_accounts LIMIT 1',
        );
        const lastAccountId = lastAccount.rows[0]?.id;
        if (!lastAccountId) {
          throw new Error('Expected the remaining GitHub account.');
        }
        providerSubject = '123456';
        const remainingSessionCookieHeader = await signInAsCurrentProvider('/after-unlink-reauthentication');
        const unlinkLast = await service.handle(
          postJson('/api/auth/unlink-account', { accountId: lastAccountId }, remainingSessionCookieHeader),
        );
        expect(unlinkLast.status).toBe(400);
        expect(
          (
            await pool.query<{ readonly count: number }>(
              'SELECT count(*)::INTEGER AS count FROM authentication_identities WHERE revoked_at IS NULL',
            )
          ).rows[0]?.count,
        ).toBe(1);

        providerSubject = '345678';
        const unapprovedSignIn = await service.handle(
          postJson('/api/auth/sign-in/social', {
            callbackURL: `${baseUrl}/must-not-sign-in`,
            disableRedirect: true,
            provider: 'github',
          }),
        );
        const unapprovedState = new URL(
          ((await unapprovedSignIn.json()) as { readonly url: string }).url,
        ).searchParams.get('state');
        if (!unapprovedState) {
          throw new Error('Expected an OAuth state for the unapproved same-email identity.');
        }
        const unapprovedCallback = await service.handle(
          new Request(
            `${baseUrl}/api/auth/callback/github?code=unapproved-code&state=${encodeURIComponent(unapprovedState)}`,
            { headers: { cookie: cookieHeader(getSetCookies(unapprovedSignIn)) } },
          ),
        );
        expect(unapprovedCallback.status).toBe(302);
        expect(unapprovedCallback.headers.get('location')).not.toBe(`${baseUrl}/must-not-sign-in`);
        const unapprovedCounts = await pool.query<{
          readonly identities: number;
          readonly mapped_subject: number;
          readonly people: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NULL) AS identities,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE provider_subject = '345678') AS mapped_subject,
          (SELECT count(*)::INTEGER FROM people) AS people`);
        expect(unapprovedCounts.rows[0]).toEqual({ identities: 1, mapped_subject: 0, people: 1 });
      } finally {
        globalThis.fetch = originalFetch;
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('serializes first-owner bootstrap and leaves the policy inert after success', async () => {
      const cluster = await startPostgresCluster('first-owner-bootstrap');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      try {
        const leftPrincipalId = crypto.randomUUID();
        const rightPrincipalId = crypto.randomUUID();
        const observedAt = '2026-08-29T12:00:00.000Z';
        for (const [principalId, subject] of [
          [leftPrincipalId, 'left-subject'],
          [rightPrincipalId, 'right-subject'],
        ] as const) {
          await pool.query(
            `INSERT INTO authentication_principals
               (id, name, email, email_verified, created_at, updated_at)
             VALUES ($1, $2, $3, TRUE, $4, $4)`,
            [principalId, subject, `${subject}@github.auth.ai-usage.invalid`, observedAt],
          );
          await pool.query(
            `INSERT INTO authentication_provider_accounts
               (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
             VALUES ($1, 'local:oauth:github', $2, 'github', $3, $4, $4)`,
            [crypto.randomUUID(), subject, principalId, observedAt],
          );
        }

        const results = await Promise.all(
          [leftPrincipalId, rightPrincipalId].map((authenticationPrincipalId) =>
            store.authentication.synchronizeAuthenticationPrincipal({
              authenticationPrincipalId,
              bootstrapFirstOwner: true,
              observedAt: parseInstant(observedAt),
            }),
          ),
        );
        expect(results.filter((result) => result.kind === 'success')).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'error')).toHaveLength(1);
        expect(
          await store.authentication.synchronizeAuthenticationPrincipal({
            authenticationPrincipalId: results[0]?.kind === 'success' ? rightPrincipalId : leftPrincipalId,
            bootstrapFirstOwner: true,
            observedAt: parseInstant(observedAt),
          }),
        ).toMatchObject({ kind: 'error' });
        const counts = await pool.query<{ readonly bootstrap: number; readonly people: number }>(`SELECT
          (SELECT count(*)::INTEGER FROM platform_bootstrap_state) AS bootstrap,
          (SELECT count(*)::INTEGER FROM people) AS people`);
        expect(counts.rows[0]).toEqual({ bootstrap: 1, people: 1 });
      } finally {
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('refuses first-owner creation when the explicit bootstrap policy is disabled', async () => {
      const cluster = await startPostgresCluster('disabled-first-owner-bootstrap');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 4,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      try {
        const authenticationPrincipalId = crypto.randomUUID();
        const observedAt = '2026-08-29T12:00:00.000Z';
        await pool.query(
          `INSERT INTO authentication_principals
             (id, name, email, email_verified, created_at, updated_at)
           VALUES ($1, 'Denied owner', 'denied@github.auth.ai-usage.invalid', TRUE, $2, $2)`,
          [authenticationPrincipalId, observedAt],
        );
        await pool.query(
          `INSERT INTO authentication_provider_accounts
             (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
           VALUES ($1, 'local:oauth:github', 'denied-subject', 'github', $2, $3, $3)`,
          [crypto.randomUUID(), authenticationPrincipalId, observedAt],
        );

        await expect(
          store.authentication.synchronizeAuthenticationPrincipal({
            authenticationPrincipalId,
            bootstrapFirstOwner: false,
            observedAt: parseInstant(observedAt),
            preferredProviderSubject: 'denied-subject',
          }),
        ).resolves.toMatchObject({ kind: 'error' });
        const counts = await pool.query<{ readonly bootstrap: number; readonly people: number }>(`SELECT
          (SELECT count(*)::INTEGER FROM platform_bootstrap_state) AS bootstrap,
          (SELECT count(*)::INTEGER FROM people) AS people`);
        expect(counts.rows[0]).toEqual({ bootstrap: 0, people: 0 });
      } finally {
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('distinguishes an absent authentication identity from a database outage', async () => {
      const cluster = await startPostgresCluster('authentication-identity-resolution');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 2,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const unknownIdentityId = parseAuthenticationIdentityId(crypto.randomUUID());
      try {
        await expect(store.authentication.resolveAuthenticationIdentity(unknownIdentityId)).resolves.toBeNull();
        await store.close();
        await expect(store.authentication.resolveAuthenticationIdentity(unknownIdentityId)).rejects.toBeDefined();
      } finally {
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('serializes concurrent unlink requests so one active provider account always remains', async () => {
      const cluster = await startPostgresCluster('shared-authentication-concurrent-unlink');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      // Both requests must pass every pre-check before either deletes: the gate
      // opens only once both unlink before-hooks have run their own check.
      let unlinkGate: (() => Promise<void>) | null = null;
      const service = createSharedAuthenticationService({
        baseUrl,
        bootstrapFirstOwner: true,
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
        database: store.authentication.database,
        identityStore: {
          ...store.authentication,
          canUnlinkAuthenticationIdentity: async (input) => {
            const allowed = await store.authentication.canUnlinkAuthenticationIdentity(input);
            await unlinkGate?.();
            return allowed;
          },
        },
        secrets: [{ value: 'auth-secret-with-more-than-thirty-two-characters-v1', version: 1 }],
      });
      let providerSubject = '123456';
      const originalFetch = globalThis.fetch;
      try {
        const mockedFetch = (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ): Promise<Response> => {
          const url = fetchInputUrl(input);
          if (url === 'https://github.com/login/oauth/access_token') {
            return Promise.resolve(
              Response.json({ access_token: 'provider-token', scope: 'read:user,user:email', token_type: 'bearer' }),
            );
          }
          if (url === 'https://api.github.com/user') {
            return Promise.resolve(
              Response.json({
                avatar_url: 'https://avatars.example.invalid/1',
                email: null,
                id: providerSubject,
                login: 'stable-login',
                name: 'Stable Person',
              }),
            );
          }
          if (url === 'https://api.github.com/user/emails') {
            return Promise.resolve(
              Response.json([{ email: 'same-email@example.invalid', primary: true, verified: true, visibility: null }]),
            );
          }
          return originalFetch(input, init);
        };
        globalThis.fetch = Object.assign(mockedFetch, { preconnect: originalFetch.preconnect });
        const completeOAuth = async (path: '/api/auth/link-social' | '/api/auth/sign-in/social', cookie?: string) => {
          const started = await service.handle(
            postJson(path, { callbackURL: `${baseUrl}/done`, disableRedirect: true, provider: 'github' }, cookie),
          );
          expect(started.status).toBe(200);
          const state = new URL(((await started.json()) as { readonly url: string }).url).searchParams.get('state');
          if (!state) {
            throw new Error(`Expected an OAuth state for ${path}.`);
          }
          const callback = await service.handle(
            new Request(`${baseUrl}/api/auth/callback/github?code=code&state=${encodeURIComponent(state)}`, {
              headers: { cookie: [cookie, cookieHeader(getSetCookies(started))].filter(Boolean).join('; ') },
            }),
          );
          expect(callback.status).toBe(302);
          expect(callback.headers.get('location')).toBe(`${baseUrl}/done`);
          const sessionCookie = getSetCookies(callback).find((value) => value.startsWith('__Host-ai-usage-session='));
          return sessionCookie ? cookieHeader([sessionCookie]) : cookie;
        };

        const sessionCookieHeader = await completeOAuth('/api/auth/sign-in/social');
        if (!sessionCookieHeader) {
          throw new Error('Expected the first Web-session cookie.');
        }
        providerSubject = '789012';
        await completeOAuth('/api/auth/link-social', sessionCookieHeader);
        const accounts = await pool.query<{ readonly id: string }>(
          'SELECT id FROM authentication_provider_accounts ORDER BY created_at, id',
        );
        expect(accounts.rows).toHaveLength(2);
        // Linking ends the session that started it; unlink needs a fresh one.
        const unlinkSessionCookieHeader = await completeOAuth('/api/auth/sign-in/social');
        if (!unlinkSessionCookieHeader) {
          throw new Error('Expected a Web-session cookie for the two-account Person.');
        }

        let arrivals = 0;
        let openGate = (): void => undefined;
        const gateOpened = new Promise<void>((resolve) => {
          openGate = resolve;
        });
        unlinkGate = async () => {
          arrivals += 1;
          if (arrivals === 2) {
            openGate();
          }
          await gateOpened;
        };
        const responses = await Promise.all(
          accounts.rows.map(({ id }) =>
            service.handle(postJson('/api/auth/unlink-account', { accountId: id }, unlinkSessionCookieHeader)),
          ),
        );
        unlinkGate = null;
        expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
        const refused = responses.find(({ status }) => status === 400);
        expect(await refused?.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });

        const state = await pool.query<{
          readonly accounts: number;
          readonly active_bound: number;
          readonly active_identities: number;
          readonly revoked_identities: number;
          readonly revoked_unbound: number;
          readonly unlink_events: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_provider_accounts) AS accounts,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NULL) AS active_identities,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NOT NULL) AS revoked_identities,
          (SELECT count(*)::INTEGER FROM authentication_identities identity
             INNER JOIN authentication_provider_accounts account
               ON account.id = identity.authentication_provider_account_id
             WHERE identity.revoked_at IS NULL) AS active_bound,
          (SELECT count(*)::INTEGER FROM authentication_identities
             WHERE revoked_at IS NOT NULL AND authentication_provider_account_id IS NULL) AS revoked_unbound,
          (SELECT count(*)::INTEGER FROM identity_events
             WHERE event_type = 'authentication-identity-unlinked') AS unlink_events`);
        expect(state.rows[0]).toEqual({
          accounts: 1,
          active_bound: 1,
          active_identities: 1,
          revoked_identities: 1,
          revoked_unbound: 1,
          unlink_events: 1,
        });

        const remaining = await pool.query<{ readonly account_id: string }>(
          'SELECT account_id FROM authentication_provider_accounts',
        );
        const remainingSubject = remaining.rows[0]?.account_id;
        if (!remainingSubject) {
          throw new Error('Expected the remaining provider account.');
        }
        providerSubject = remainingSubject;
        const remainingSessionCookieHeader = await completeOAuth('/api/auth/sign-in/social');
        if (!remainingSessionCookieHeader) {
          throw new Error('Expected a Web-session cookie for the remaining account.');
        }
        await expect(
          service.resolveSession(new Headers({ cookie: remainingSessionCookieHeader })),
        ).resolves.toMatchObject({ kind: 'authenticated', session: { principal: { provider: 'github' } } });
      } finally {
        globalThis.fetch = originalFetch;
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('invalidates the sessions of an unlinked identity and refuses account management with a revoked session', async () => {
      const cluster = await startPostgresCluster('shared-authentication-revoked-session');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      const service = createSharedAuthenticationService({
        baseUrl,
        bootstrapFirstOwner: true,
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
        database: store.authentication.database,
        identityStore: store.authentication,
        secrets: [{ value: 'auth-secret-with-more-than-thirty-two-characters-v1', version: 1 }],
      });
      const subject = { current: '123456' };
      const oauth = createOAuthFlow(service, subject);
      const accountIdOf = async (providerSubject: string): Promise<string> => {
        const result = await pool.query<{ readonly id: string }>(
          'SELECT id FROM authentication_provider_accounts WHERE account_id = $1',
          [providerSubject],
        );
        const id = result.rows[0]?.id;
        if (!id) {
          throw new Error(`Expected a provider account for subject ${providerSubject}.`);
        }
        return id;
      };
      const counts = async () => {
        const result = await pool.query<{
          readonly accounts: number;
          readonly active_identities: number;
          readonly sessions: number;
          readonly session_revocations: number;
          readonly unlinks: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_provider_accounts) AS accounts,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NULL) AS active_identities,
          (SELECT count(*)::INTEGER FROM web_sessions) AS sessions,
          (SELECT count(*)::INTEGER FROM identity_events WHERE event_type = 'web-session-revoked')
            AS session_revocations,
          (SELECT count(*)::INTEGER FROM identity_events WHERE event_type = 'authentication-identity-unlinked')
            AS unlinks`);
        return result.rows[0];
      };
      const linkSocial = (cookie: string) =>
        service.handle(
          postJson(
            '/api/auth/link-social',
            { callbackURL: `${baseUrl}/done`, disableRedirect: true, provider: 'github' },
            cookie,
          ),
        );
      try {
        // Sign in through A, link B, then hold a fresh session created through A.
        const bootstrapSession = await oauth.complete('/api/auth/sign-in/social');
        subject.current = '789012';
        await oauth.complete('/api/auth/link-social', bootstrapSession);
        subject.current = '123456';
        const sessionA = await oauth.complete('/api/auth/sign-in/social');
        if (!sessionA) {
          throw new Error('Expected a Web-session cookie created through identity A.');
        }
        expect(await counts()).toMatchObject({ accounts: 2, active_identities: 2, sessions: 1 });

        // Unlinking A while holding A's session ends that session server-side:
        // Better Auth no longer accepts it and the resolver no longer finds it.
        const unlinkA = await service.handle(
          postJson('/api/auth/unlink-account', { accountId: await accountIdOf('123456') }, sessionA),
        );
        expect(unlinkA.status).toBe(200);
        expect(await counts()).toEqual({
          accounts: 1,
          active_identities: 1,
          session_revocations: 1,
          sessions: 0,
          unlinks: 1,
        });
        await expect(service.resolveSession(new Headers({ cookie: sessionA }))).resolves.toEqual({
          kind: 'anonymous',
        });
        expect((await linkSocial(sessionA)).status).toBe(401);
        expect(await counts()).toMatchObject({ accounts: 1, active_identities: 1 });

        // B still signs in, and a valid session can still link and unlink.
        subject.current = '789012';
        const sessionB = await oauth.complete('/api/auth/sign-in/social');
        if (!sessionB) {
          throw new Error('Expected a Web-session cookie created through identity B.');
        }
        await expect(service.resolveSession(new Headers({ cookie: sessionB }))).resolves.toMatchObject({
          kind: 'authenticated',
        });
        subject.current = '345678';
        await oauth.complete('/api/auth/link-social', sessionB);
        expect(await counts()).toMatchObject({ accounts: 2, active_identities: 2 });
        subject.current = '789012';
        const sessionB2 = await oauth.complete('/api/auth/sign-in/social');
        if (!sessionB2) {
          throw new Error('Expected a second Web-session cookie created through identity B.');
        }
        expect(
          (
            await service.handle(
              postJson('/api/auth/unlink-account', { accountId: await accountIdOf('345678') }, sessionB2),
            )
          ).status,
        ).toBe(200);
        expect(await counts()).toMatchObject({ accounts: 1, active_identities: 1, sessions: 1 });

        // Defense in depth: the identity behind a live session is revoked out of
        // band (its session row stays). A link that session had already started
        // must not complete, and every account-management route refuses the
        // session with 401 while sign-out still ends it.
        subject.current = '345678';
        const pendingLink = await oauth.start('/api/auth/link-social', sessionB2);
        expect(pendingLink.started.status).toBe(200);
        if (!pendingLink.state) {
          throw new Error('Expected a pending link state.');
        }
        await pool.query("UPDATE authentication_identities SET revoked_at = now() WHERE provider_subject = '789012'");
        const completedLink = await oauth.callback(pendingLink.state, [
          sessionB2,
          cookieHeader(getSetCookies(pendingLink.started)),
        ]);
        expect(completedLink.headers.get('location')).not.toBe(`${baseUrl}/done`);
        expect(await counts()).toMatchObject({ accounts: 1, active_identities: 0, sessions: 1 });
        await expect(service.resolveSession(new Headers({ cookie: sessionB2 }))).resolves.toEqual({ kind: 'revoked' });
        expect((await linkSocial(sessionB2)).status).toBe(401);
        expect(
          (
            await service.handle(
              postJson('/api/auth/unlink-account', { accountId: await accountIdOf('789012') }, sessionB2),
            )
          ).status,
        ).toBe(401);
        expect((await service.handle(postJson('/api/auth/revoke-sessions', {}, sessionB2))).status).toBe(401);
        expect((await service.handle(postJson('/api/auth/sign-out', {}, sessionB2))).status).toBe(200);
        expect(await counts()).toMatchObject({ accounts: 1, sessions: 0 });
      } finally {
        oauth.restore();
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('refuses relinking an unlinked identity before any provider account is written', async () => {
      const cluster = await startPostgresCluster('shared-authentication-relink');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      const service = createSharedAuthenticationService({
        baseUrl,
        bootstrapFirstOwner: true,
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
        database: store.authentication.database,
        identityStore: store.authentication,
        secrets: [{ value: 'auth-secret-with-more-than-thirty-two-characters-v1', version: 1 }],
      });
      const subject = { current: '789012' };
      const oauth = createOAuthFlow(service, subject);
      const counts = async () => {
        const result = await pool.query<{
          readonly accounts: number;
          readonly active_identities: number;
          readonly revoked_identities: number;
        }>(`SELECT
          (SELECT count(*)::INTEGER FROM authentication_provider_accounts) AS accounts,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NULL) AS active_identities,
          (SELECT count(*)::INTEGER FROM authentication_identities WHERE revoked_at IS NOT NULL)
            AS revoked_identities`);
        return result.rows[0];
      };
      try {
        // B is the owner; C is linked, then unlinked, so C's identity row is revoked.
        const bootstrapSession = await oauth.complete('/api/auth/sign-in/social');
        subject.current = '345678';
        await oauth.complete('/api/auth/link-social', bootstrapSession);
        const accountC = await pool.query<{ readonly id: string }>(
          "SELECT id FROM authentication_provider_accounts WHERE account_id = '345678'",
        );
        const accountCId = accountC.rows[0]?.id;
        if (!accountCId) {
          throw new Error("Expected C's provider account.");
        }
        subject.current = '789012';
        const sessionB = await oauth.complete('/api/auth/sign-in/social');
        if (!sessionB) {
          throw new Error('Expected a Web-session cookie created through identity B.');
        }
        expect(
          (await service.handle(postJson('/api/auth/unlink-account', { accountId: accountCId }, sessionB))).status,
        ).toBe(200);
        const unlinked = { accounts: 1, active_identities: 1, revoked_identities: 1 };
        expect(await counts()).toEqual(unlinked);

        // Relinking C with B's valid session is refused before Better Auth writes
        // the provider-account row, so no orphan can later reject the principal.
        subject.current = '345678';
        const relink = await oauth.start('/api/auth/link-social', sessionB);
        expect(relink.started.status).toBe(200);
        if (!relink.state) {
          throw new Error('Expected a relink state.');
        }
        const relinkCallback = await oauth.callback(relink.state, [
          sessionB,
          cookieHeader(getSetCookies(relink.started)),
        ]);
        expect(relinkCallback.headers.get('location')).not.toBe(`${baseUrl}/done`);
        expect(relinkCallback.status).toBe(400);
        expect(await relinkCallback.json()).toMatchObject({ code: 'IDENTITY_REVOKED' });
        expect(await counts()).toEqual(unlinked);

        // B keeps signing in, and unlinking the refused C is an explicit refusal:
        // only B's account exists, so Better Auth's own last-account check answers.
        subject.current = '789012';
        const sessionB2 = await oauth.complete('/api/auth/sign-in/social');
        if (!sessionB2) {
          throw new Error('Expected a second Web-session cookie created through identity B.');
        }
        await expect(service.resolveSession(new Headers({ cookie: sessionB2 }))).resolves.toMatchObject({
          kind: 'authenticated',
        });
        const unlinkRefused = await service.handle(
          postJson('/api/auth/unlink-account', { accountId: accountCId }, sessionB2),
        );
        expect(unlinkRefused.status).toBe(400);
        expect(await unlinkRefused.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
        expect(await counts()).toEqual(unlinked);
      } finally {
        oauth.restore();
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
