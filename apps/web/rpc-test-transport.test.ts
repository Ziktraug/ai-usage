import { describe, expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import {
  CAMPAIGN_LABELS_RPC_PATH,
  campaignLabelsFailureFulfillment,
  decodeRpcResponseBody,
  encodeRpcResponseBody,
  isExpectedCampaignLabelsFailureResponse,
  isExpectedSkillsSaveFailureResponse,
  isRpcPathname,
  type RpcRouteFulfillment,
  rpcRouteFulfillmentForClientResult,
  rpcStringFieldValues,
  SKILLS_SAVE_RPC_PATH,
} from './e2e/rpc-test-transport';
import { createWebRpcClient } from './src/lib/rpc/client';
import { createReportClient } from './src/lib/rpc/report-client';
import { createSkillsClient } from './src/lib/rpc/skills-client';

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
            headers: { 'content-type': 'application/json', ...fulfillment.headers },
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
    const expectedFailureResponse = {
      headers: failure.headers,
      pathname: SKILLS_SAVE_RPC_PATH,
      status: failure.status,
    };
    expect(isExpectedSkillsSaveFailureResponse(expectedFailureResponse)).toBe(true);
    expect(isExpectedSkillsSaveFailureResponse({ ...expectedFailureResponse, headers: {} })).toBe(false);
    expect(isExpectedSkillsSaveFailureResponse({ ...expectedFailureResponse, pathname: '/rpc/report/overview' })).toBe(
      false,
    );
    expect(isExpectedSkillsSaveFailureResponse({ ...expectedFailureResponse, status: 500 })).toBe(false);
    expect(await skillsClientFor(failure).saveManagedSkillMarkdown(saveInput)).toEqual({
      error: { message: 'Storage unavailable', tag: 'E2ESaveFailure' },
      ok: false,
    });
  });

  test('fails the saved campaign labels read through the real RPCLink as its procedure does', async () => {
    const failure = campaignLabelsFailureFulfillment();
    const identity = { headers: failure.headers, pathname: CAMPAIGN_LABELS_RPC_PATH, status: failure.status };
    expect(isExpectedCampaignLabelsFailureResponse(identity)).toBe(true);
    expect(isExpectedCampaignLabelsFailureResponse({ ...identity, headers: {} })).toBe(false);
    expect(isExpectedCampaignLabelsFailureResponse({ ...identity, pathname: SKILLS_SAVE_RPC_PATH })).toBe(false);
    expect(isExpectedSkillsSaveFailureResponse(identity)).toBe(false);

    const client = createReportClient(
      createWebRpcClient({
        fetch: () =>
          Promise.resolve(
            new Response(failure.body, {
              headers: { 'content-type': 'application/json', ...failure.headers },
              status: failure.status,
            }),
          ),
        url: 'http://127.0.0.1/rpc',
      }),
    );
    const error = await client.getCampaignLabelOverrides().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: 'Unavailable',
      defined: true,
      message: 'Campaign labels are temporarily unavailable.',
    });
  });
});
