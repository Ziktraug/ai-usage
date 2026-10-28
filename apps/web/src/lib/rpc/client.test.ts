import { describe, expect, test } from 'bun:test';
import { webContract } from '@ai-usage/web-contract';
import { rpcProcedureTable } from '@ai-usage/web-contract/rpc-procedure-table';
import { frozenRequestPolicyBehaviour } from '../server/rpc/request-policy.frozen';
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
    expect(rpcMethodForPath(['sync', 'fleet'])).toBe('GET');
    expect(rpcMethodForPath(['workRouting', 'context'])).toBe('GET');
    expect(rpcMethodForPath(['delegation', 'settings'])).toBe('GET');
    expect(rpcMethodForPath(['delegation', 'jobs'])).toBe('GET');
    expect(rpcMethodForPath(['delegation', 'job'])).toBe('GET');
    expect(rpcMethodForPath(['delegation', 'saveSettings'])).toBe('POST');
    expect(rpcMethodForPath(['delegation', 'simulate'])).toBe('POST');
    expect(rpcMethodForPath(['delegation', 'cancel'])).toBe('POST');
    expect(rpcMethodForPath(['delegation', 'recordAcceptance'])).toBe('POST');
    expect(rpcMethodForPath(['campaign', 'setLabelOverride'])).toBe('POST');
  });

  test('sends every contract procedure with the method its declaration names', () => {
    const procedures = rpcProcedureTable(webContract);
    for (const procedure of procedures) {
      expect({ method: rpcMethodForPath(procedure.path), path: procedure.path }).toEqual({
        method: procedure.method,
        path: procedure.path,
      });
    }
    // The same GET set the browser used when it was hand-written.
    expect(
      procedures.filter(({ path }) => rpcMethodForPath(path) === 'GET').map(({ path }) => `/${path.join('/')}`),
    ).toEqual(expect.arrayContaining([...frozenRequestPolicyBehaviour.browserGetPaths]));
    expect(procedures.filter(({ path }) => rpcMethodForPath(path) === 'GET')).toHaveLength(
      frozenRequestPolicyBehaviour.browserGetPaths.length,
    );
  });
});
