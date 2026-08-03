import { describe, expect, test } from 'bun:test';
import { normalizeOwnedRpcSubrequest } from './subrequest-normalization.server';

const rpcUrl = new URL('http://127.0.0.1:3000/rpc/report/revisionBootstrap');
const ownerHeaders = { 'x-ai-usage-request-owner': 'synthetic-test' };

describe('normalizeOwnedRpcSubrequest', () => {
  test('leaves an external missing-Host request untrusted even when its owner header is spoofed', () => {
    const request = new Request(rpcUrl, { headers: ownerHeaders });
    const normalized = normalizeOwnedRpcSubrequest({ isSubRequest: false, request, url: rpcUrl });

    expect(normalized).toBe(request);
    expect(normalized.headers.get('host')).toBeNull();
    expect(normalized.headers.get('origin')).toBeNull();
  });

  test('restores same-origin evidence for a framework-owned internal subrequest', () => {
    const request = new Request(rpcUrl, { headers: ownerHeaders });
    const normalized = normalizeOwnedRpcSubrequest({ isSubRequest: true, request, url: rpcUrl });

    expect(normalized).not.toBe(request);
    expect(normalized.headers.get('host')).toBe(rpcUrl.host);
    expect(normalized.headers.get('origin')).toBe(rpcUrl.origin);
    expect(normalized.headers.get('sec-fetch-site')).toBe('same-origin');
  });

  test('does not rewrite externally supplied trust evidence', () => {
    const request = new Request(rpcUrl, {
      headers: {
        ...ownerHeaders,
        host: 'attacker.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    const normalized = normalizeOwnedRpcSubrequest({ isSubRequest: false, request, url: rpcUrl });

    expect(normalized).toBe(request);
    expect(normalized.headers.get('host')).toBe('attacker.example');
    expect(normalized.headers.get('origin')).toBe('https://attacker.example');
    expect(normalized.headers.get('sec-fetch-site')).toBe('cross-site');
  });
});
