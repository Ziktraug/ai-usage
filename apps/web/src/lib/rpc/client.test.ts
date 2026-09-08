import { describe, expect, test } from 'bun:test';
import { browserWebRpcUrl, rpcMethodForPath } from './client';

describe('Web RPC client composition', () => {
  test('resolves the browser RPC endpoint against the exact current origin', () => {
    expect(browserWebRpcUrl('https://usage.example.test/report?tab=sessions#drawer').href).toBe(
      'https://usage.example.test/rpc',
    );
    expect(browserWebRpcUrl(new URL('http://127.0.0.1:4174/skills/global')).href).toBe('http://127.0.0.1:4174/rpc');
  });

  test('keeps the frozen read-only operation set on GET and mutations on POST', () => {
    expect(rpcMethodForPath(['report', 'revisionBootstrap'])).toBe('GET');
    expect(rpcMethodForPath(['skills', 'snapshot'])).toBe('GET');
    expect(rpcMethodForPath(['replication', 'status'])).toBe('GET');
    expect(rpcMethodForPath(['campaign', 'setLabelOverride'])).toBe('POST');
  });
});
