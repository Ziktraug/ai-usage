import { describe, expect, test } from 'bun:test';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tools/pg-harness';
import { createPlatformApplicationHandler } from './application';
import { parsePlatformServerConfig } from './config';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const baseUrl = 'https://platform.example.invalid';

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

const jsonRequest = (
  path: string,
  body: unknown,
  options: { readonly cookie?: string; readonly method?: string; readonly origin?: string } = {},
): Request =>
  new Request(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    method: options.method ?? 'POST',
  });

if (runPostgresTests) {
  describe('connected platform HTTP application', () => {
    test('enforces session, CSRF, one-time enrollment, atomic rotation, and revocation boundaries', async () => {
      const cluster = await startPostgresCluster('platform-http-application');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const pool = new Pool({ connectionString: cluster.url, max: 2 });
      const config = parsePlatformServerConfig({
        AI_USAGE_AUTH_SECRETS: `1:${Buffer.alloc(32, 41).toString('base64url')}`,
        AI_USAGE_DEVICE_TOKEN_KEYS: `3:${Buffer.alloc(32, 42).toString('base64url')}`,
        AI_USAGE_FIRST_OWNER_BOOTSTRAP: 'true',
        AI_USAGE_GITHUB_CLIENT_ID: 'github-client-id',
        AI_USAGE_GITHUB_CLIENT_SECRET: 'github-client-secret-with-enough-entropy',
        AI_USAGE_PLATFORM_BASE_URL: baseUrl,
        AI_USAGE_PLATFORM_DATABASE_TLS: 'disable',
        AI_USAGE_PLATFORM_DATABASE_URL: cluster.url,
        NODE_ENV: 'test',
      });
      const application = createPlatformApplicationHandler(config, store);
      const providerAccessToken = 'provider-token-must-never-reach-http';
      const originalFetch = globalThis.fetch;
      try {
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
                avatar_url: null,
                email: null,
                id: 'http-owner-subject',
                login: 'http-owner',
                name: 'HTTP owner',
              }),
            );
          }
          if (url === 'https://api.github.com/user/emails') {
            return Promise.resolve(
              Response.json([{ email: 'http-owner@example.invalid', primary: true, verified: true, visibility: null }]),
            );
          }
          return originalFetch(input, init);
        };
        globalThis.fetch = Object.assign(mockedFetch, { preconnect: originalFetch.preconnect });

        const signIn = await application(
          jsonRequest(
            '/api/auth/sign-in/social',
            { callbackURL: `${baseUrl}/after`, disableRedirect: true, provider: 'github' },
            { origin: baseUrl },
          ),
        );
        const authorizationUrl = new URL(((await signIn.json()) as { readonly url: string }).url);
        const state = authorizationUrl.searchParams.get('state');
        if (!state) {
          throw new Error('Expected an OAuth state.');
        }
        const callback = await application(
          new Request(`${baseUrl}/api/auth/callback/github?code=http-code&state=${encodeURIComponent(state)}`, {
            headers: { cookie: cookieHeader(getSetCookies(signIn)) },
          }),
        );
        const sessionCookie = getSetCookies(callback).find((cookie) => cookie.startsWith('__Host-ai-usage-session='));
        if (!sessionCookie) {
          throw new Error('Expected a Web-session cookie.');
        }
        const sessionCookieHeader = cookieHeader([sessionCookie]);
        const sessionResponse = await application(
          new Request(`${baseUrl}/api/session`, { headers: { cookie: sessionCookieHeader } }),
        );
        expect(sessionResponse.status).toBe(200);
        const sessionBody = (await sessionResponse.json()) as {
          readonly session: { readonly principal: { readonly personId: string } };
        };
        const personalSpace = await pool.query<{ readonly personal_space_id: string }>(
          'SELECT personal_space_id FROM people WHERE id = $1',
          [sessionBody.session.principal.personId],
        );
        const spaceId = personalSpace.rows[0]?.personal_space_id;
        if (!spaceId) {
          throw new Error('Expected the bootstrapped personal Space.');
        }

        expect(
          (
            await application(
              new Request(`${baseUrl}/api/device-enrollment-grants`, {
                body: JSON.stringify({ label: 'x'.repeat(17 * 1024), spaceId }),
                headers: {
                  'content-type': 'application/json',
                  cookie: sessionCookieHeader,
                  origin: baseUrl,
                },
                method: 'POST',
              }),
            )
          ).status,
        ).toBe(400);

        expect(
          (
            await application(
              jsonRequest(
                '/api/device-enrollment-grants',
                { label: 'HTTP laptop', spaceId },
                { cookie: sessionCookieHeader, origin: 'https://attacker.example.invalid' },
              ),
            )
          ).status,
        ).toBe(403);
        const grantResponse = await application(
          jsonRequest(
            '/api/device-enrollment-grants',
            { label: 'HTTP laptop', spaceId },
            { cookie: sessionCookieHeader, origin: baseUrl },
          ),
        );
        expect(grantResponse.status).toBe(201);
        const grantText = await grantResponse.text();
        const grantBody = JSON.parse(grantText) as { readonly token: string };
        expect(grantText).not.toContain('keyedDigest');
        expect(grantText).not.toContain('publicTokenId');

        const exchangeResponse = await application(
          jsonRequest('/api/device-enrollment-exchanges', { token: grantBody.token }),
        );
        expect(exchangeResponse.status).toBe(201);
        const exchangeText = await exchangeResponse.text();
        const exchangeBody = JSON.parse(exchangeText) as {
          readonly device: { readonly id: string };
          readonly token: string;
        };
        expect(exchangeText).not.toContain('keyedDigest');
        expect(exchangeText).not.toContain('publicTokenId');
        expect(
          (await application(jsonRequest('/api/device-enrollment-exchanges', { token: grantBody.token }))).status,
        ).toBe(401);

        const verify = (token: string): Promise<Response> =>
          application(
            new Request(`${baseUrl}/api/device-credentials/verify`, {
              headers: { authorization: `Bearer ${token}` },
              method: 'POST',
            }),
          );
        const verified = await verify(exchangeBody.token);
        expect(verified.status).toBe(200);
        const verifiedText = await verified.text();
        expect(verifiedText).not.toContain('keyedDigest');
        expect(verifiedText).not.toContain('publicTokenId');

        const rotationResponse = await application(
          jsonRequest(
            `/api/devices/${exchangeBody.device.id}/credential-rotation?spaceId=${spaceId}`,
            {},
            { cookie: sessionCookieHeader, origin: baseUrl },
          ),
        );
        expect(rotationResponse.status).toBe(201);
        const rotated = (await rotationResponse.json()) as { readonly token: string };
        expect(rotated.token).not.toBe(exchangeBody.token);
        expect((await verify(exchangeBody.token)).status).toBe(401);
        expect((await verify(rotated.token)).status).toBe(200);

        const listResponse = await application(
          new Request(`${baseUrl}/api/devices?spaceId=${spaceId}`, {
            headers: { cookie: sessionCookieHeader },
          }),
        );
        expect(listResponse.status).toBe(200);
        expect(await listResponse.json()).toMatchObject({
          items: [{ credentialCreatedAt: expect.any(String), device: { id: exchangeBody.device.id } }],
        });

        const revoked = await application(
          new Request(`${baseUrl}/api/devices/${exchangeBody.device.id}?spaceId=${spaceId}`, {
            headers: { cookie: sessionCookieHeader, origin: baseUrl },
            method: 'DELETE',
          }),
        );
        expect(revoked.status).toBe(200);
        expect((await verify(rotated.token)).status).toBe(401);
        expect(
          (
            await pool.query<{ readonly count: number }>(
              'SELECT count(*)::INTEGER AS count FROM devices WHERE id = $1',
              [exchangeBody.device.id],
            )
          ).rows[0]?.count,
        ).toBe(1);

        const persistedSecrets = await pool.query<{
          readonly credential_digest: string;
          readonly grant_digest: string;
          readonly provider_token: string;
        }>(`SELECT
          (SELECT keyed_digest FROM device_credentials ORDER BY created_at ASC LIMIT 1) AS credential_digest,
          (SELECT keyed_digest FROM device_enrollment_grants LIMIT 1) AS grant_digest,
          (SELECT access_token FROM authentication_provider_accounts LIMIT 1) AS provider_token`);
        const persisted = persistedSecrets.rows[0];
        expect(persisted?.credential_digest).not.toContain(exchangeBody.token);
        expect(persisted?.grant_digest).not.toContain(grantBody.token);
        expect(persisted?.provider_token).not.toContain(providerAccessToken);

        expect(
          (
            await application(
              jsonRequest('/api/session/revoke-all', {}, { cookie: sessionCookieHeader, origin: baseUrl }),
            )
          ).status,
        ).toBe(204);
        expect(
          (await application(new Request(`${baseUrl}/api/session`, { headers: { cookie: sessionCookieHeader } })))
            .status,
        ).toBe(204);
        const audited = await pool.query<{ readonly event_type: string }>(
          `SELECT event_type
           FROM identity_events
           WHERE event_type IN
             ('shared-login-succeeded', 'web-session-revoked',
              'device-enrollment-grant-created', 'device-enrollment-grant-exchanged',
              'device-credential-rotated', 'device-revoked')
           ORDER BY event_type ASC`,
        );
        expect(audited.rows.map((row) => row.event_type)).toEqual([
          'device-credential-rotated',
          'device-enrollment-grant-created',
          'device-enrollment-grant-exchanged',
          'device-revoked',
          'shared-login-succeeded',
          'web-session-revoked',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        await pool.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
