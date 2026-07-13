import { describe, expect, test } from 'bun:test';
import { validateTrustedLocalRequest } from './local-request-trust.server';

const localRequest = (headers: Record<string, string> = {}, url = 'http://127.0.0.1/resource') =>
  new Request(url, { headers });

describe('trusted local request boundary', () => {
  test('accepts each loopback hostname with arbitrary ports', () => {
    const trustedHosts = ['localhost', 'localhost:4312', '127.0.0.1:8080', '[::1]:9999'];

    for (const host of trustedHosts) {
      expect(validateTrustedLocalRequest(localRequest({ host }))).toBeNull();
    }
  });

  test('rejects missing, non-loopback, and DNS-rebinding Host values', async () => {
    const missingHost = validateTrustedLocalRequest(localRequest());
    const remoteHost = validateTrustedLocalRequest(localRequest({ host: '192.168.1.10:3000' }));
    const rebindingHost = validateTrustedLocalRequest(localRequest({ host: 'attacker.example:3000' }));

    expect(missingHost?.status).toBe(400);
    expect(remoteHost?.status).toBe(403);
    expect(rebindingHost?.status).toBe(403);
    expect(await rebindingHost?.json()).toMatchObject({ error: { tag: 'UntrustedHost' }, ok: false });
  });

  test('rejects mismatched and malformed origins', () => {
    const mismatchedOrigin = validateTrustedLocalRequest(
      localRequest({ host: 'localhost:3000', origin: 'http://attacker.example' }),
    );
    const malformedOrigin = validateTrustedLocalRequest(
      localRequest({ host: 'localhost:3000', origin: 'not-an-origin' }),
    );

    expect(mismatchedOrigin?.status).toBe(403);
    expect(malformedOrigin?.status).toBe(400);
  });

  test('rejects cross-site fetch metadata and forwarded-protocol confusion', () => {
    const crossSite = validateTrustedLocalRequest(
      localRequest({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }),
    );
    const forwardedProtocol = validateTrustedLocalRequest(
      localRequest({ host: 'localhost:3000', origin: 'https://localhost:3000', 'x-forwarded-proto': 'https' }),
    );

    expect(crossSite?.status).toBe(403);
    expect(forwardedProtocol?.status).toBe(403);
  });

  test('accepts same-origin browser metadata', () => {
    const request = localRequest({
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    });

    expect(validateTrustedLocalRequest(request)).toBeNull();
  });
});
