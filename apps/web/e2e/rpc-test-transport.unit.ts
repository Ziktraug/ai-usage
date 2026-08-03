import { describe, expect, test } from 'bun:test';
import { createWebRpcClient } from '../src/lib/rpc/client';
import { createSkillsClient } from '../src/lib/rpc/skills-client';
import {
  decodeRpcResponseBody,
  encodeRpcResponseBody,
  isRpcPathname,
  type RpcRouteFulfillment,
  rpcRouteFulfillmentForClientResult,
  rpcStringFieldValues,
} from './rpc-test-transport';

const saveInput = {
  baseSha256: 'a'.repeat(64),
  content: '# Browser draft',
  skillName: 'example',
};

const skillsClientFor = (fulfillment: RpcRouteFulfillment) =>
  createSkillsClient(
    createWebRpcClient({
      fetch: () =>
        Promise.resolve(
          new Response(fulfillment.body, {
            headers: { 'content-type': 'application/json' },
            status: fulfillment.status,
          }),
        ),
      url: 'http://127.0.0.1/rpc',
    }).skills,
  );

describe('RPC test transport helpers', () => {
  test('matches only the actual RPC boundary', () => {
    expect(isRpcPathname('/rpc')).toBe(true);
    expect(isRpcPathname('/rpc/session/page')).toBe(true);
    expect(isRpcPathname('/rpc-private')).toBe(false);
    expect(isRpcPathname('/sync')).toBe(false);
  });

  test('decodes the standard oRPC envelope before collecting response identities', () => {
    const body = encodeRpcResponseBody({
      nested: [
        { requestFingerprint: 'session-query-v1:0123456789abcdef', revision: 'revision-a' },
        { revision: 'revision-a' },
      ],
      recordedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    expect(rpcStringFieldValues(body, 'requestFingerprint')).toEqual(['session-query-v1:0123456789abcdef']);
    expect(rpcStringFieldValues(body, 'revision')).toEqual(['revision-a', 'revision-a']);
    expect(decodeRpcResponseBody(body)).toEqual({
      nested: [
        { requestFingerprint: 'session-query-v1:0123456789abcdef', revision: 'revision-a' },
        { revision: 'revision-a' },
      ],
      recordedAt: new Date('2026-07-03T00:00:00.000Z'),
    });
  });

  test('translates intercepted outcomes through the real RPCLink and Skills client adapter', async () => {
    const success = rpcRouteFulfillmentForClientResult({ data: { reason: 'conflict' }, ok: true });
    expect(success.status).toBe(200);
    expect(decodeRpcResponseBody(success.body)).toEqual({ reason: 'conflict' });
    expect(await skillsClientFor(success).saveManagedSkillMarkdown(saveInput)).toEqual({
      data: { reason: 'conflict' },
      ok: true,
    });

    const failure = rpcRouteFulfillmentForClientResult({
      error: { message: 'Storage unavailable', tag: 'E2ESaveFailure' },
      ok: false,
    });
    expect(failure.status).toBe(503);
    expect(await skillsClientFor(failure).saveManagedSkillMarkdown(saveInput)).toEqual({
      error: { message: 'Storage unavailable', tag: 'E2ESaveFailure' },
      ok: false,
    });
  });
});
