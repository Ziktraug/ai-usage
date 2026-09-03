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
  });
}
