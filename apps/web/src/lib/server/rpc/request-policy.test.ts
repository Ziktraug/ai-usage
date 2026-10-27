import { describe, expect, test } from 'bun:test';
import { webContract } from '@ai-usage/web-contract';
import { rpcProcedureTable } from '@ai-usage/web-contract/rpc-procedure-table';
import {
  explicitHttpRequestPolicies,
  observableErrorFamiliesFor,
  type RequestPolicy,
  requestPolicyMatrix,
  rpcProcedureRequestPolicies,
} from './request-policy';
import { frozenRequestPolicyBehaviour } from './request-policy.frozen';
import { explicitPolicyForPath, rpcPolicyForPath } from './request-policy-handler';

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

interface PolicyBehaviour {
  readonly applicationErrorFamilies: readonly string[];
  readonly csrf: string;
  readonly demo: string;
  readonly method: string;
  readonly requestSize: string;
  readonly responseSize: string;
  readonly transport: string;
  readonly trustedLocal: string;
}

const behaviourOf = (policy: RequestPolicy): PolicyBehaviour => ({
  applicationErrorFamilies: sorted(policy.applicationErrorFamilies),
  csrf: policy.csrf,
  demo: policy.demo,
  method: policy.method,
  requestSize: policy.requestSize,
  responseSize: policy.responseSize,
  transport: policy.transport,
  trustedLocal: policy.trustedLocal,
});

const byRpcPath = (policy: RequestPolicy): string =>
  policy.source === 'rpc-procedure' ? policy.path : `<explicit> ${policy.target}`;

describe('request policy matrix', () => {
  test('derives exactly the behaviour every operation had when the table was hand-written', () => {
    const derived: Readonly<Record<string, PolicyBehaviour>> = Object.fromEntries(
      rpcProcedureRequestPolicies.map((policy) => [policy.path, behaviourOf(policy)]),
    );
    const explicit: Readonly<Record<string, PolicyBehaviour>> = Object.fromEntries(
      explicitHttpRequestPolicies.map((policy) => [policy.target, behaviourOf(policy)]),
    );
    const frozenRpc: Readonly<Record<string, PolicyBehaviour>> = frozenRequestPolicyBehaviour.rpc;
    const frozenExplicit: Readonly<Record<string, PolicyBehaviour>> = frozenRequestPolicyBehaviour.explicitHttp;

    expect(derived).toEqual(frozenRpc);
    expect(explicit).toEqual(frozenExplicit);
  });

  test('derives one reachable policy per contract procedure and nothing else', () => {
    const procedures = rpcProcedureTable(webContract);

    expect(rpcProcedureRequestPolicies).toHaveLength(procedures.length);
    for (const procedure of procedures) {
      expect(rpcPolicyForPath(`/${procedure.path.join('/')}`)).toMatchObject({
        method: procedure.method,
        target: procedure.path.join('.'),
        transport: procedure.transport,
      });
    }
    expect(rpcPolicyForPath('/report')).toBeUndefined();
    expect(rpcPolicyForPath('/report/revisionManifest/extra')).toBeUndefined();
    expect(requestPolicyMatrix).toHaveLength(procedures.length + explicitHttpRequestPolicies.length);
    expect(new Set(requestPolicyMatrix.map(byRpcPath)).size).toBe(requestPolicyMatrix.length);
    expect(new Set(requestPolicyMatrix.map(({ id }) => id)).size).toBe(requestPolicyMatrix.length);
  });

  test('keeps transport, method, CSRF, and size classes internally coherent', () => {
    for (const policy of rpcProcedureRequestPolicies) {
      expect(policy.target.length).toBeGreaterThan(0);
      expect(policy.csrf).toBe(policy.transport === 'mutation' ? 'required' : 'not-required');
      expect(policy.responseSize).toBe('bounded-json');

      if (policy.transport === 'mutation') {
        expect(policy.method).toBe('POST');
      }
      if (policy.requestSize === 'bounded-url') {
        expect(policy.method).toBe('GET');
      }
      if (policy.requestSize === 'bounded-rpc-json') {
        expect(policy.method).toBe('POST');
      }
    }
  });

  test('normalizes the side-effecting Skills refresh to POST while retaining POST queries until their owners prove a change', () => {
    expect(rpcPolicyForPath('/skills/refreshSnapshot')).toMatchObject({
      csrf: 'required',
      method: 'POST',
      transport: 'mutation',
    });
    expect(rpcPolicyForPath('/skills/managedMarkdown')).toMatchObject({
      csrf: 'not-required',
      method: 'POST',
      transport: 'query',
    });
    expect(rpcPolicyForPath('/report/focusedOverview')).toMatchObject({
      csrf: 'not-required',
      method: 'POST',
      transport: 'query',
    });
  });

  test('freezes the explicit SSE, command, upload, and download classes with no route-policy bypass', () => {
    expect(explicitHttpRequestPolicies).toEqual([
      expect.objectContaining({
        csrf: 'not-required',
        id: 'http:source-control-events',
        method: 'GET',
        responseSize: 'bounded-sse-events',
        transport: 'sse',
      }),
      expect.objectContaining({
        csrf: 'required',
        id: 'http:source-control-command',
        method: 'POST',
        requestSize: 'source-control-command-json-4kib',
        transport: 'command',
      }),
      expect.objectContaining({
        csrf: 'required',
        id: 'http:manual-merge-upload',
        method: 'POST',
        requestSize: 'portable-usage-upload',
        transport: 'upload',
      }),
      expect.objectContaining({
        csrf: 'required',
        id: 'http:manual-merge-download',
        method: 'POST',
        requestSize: 'none',
        responseSize: 'portable-usage-json',
        transport: 'file',
      }),
    ]);
    for (const policy of explicitHttpRequestPolicies) {
      expect(explicitPolicyForPath(policy.target)).toBe(policy);
      expect(rpcPolicyForPath(policy.target)).toBeUndefined();
    }
  });

  test('isolates the synthetic demo procedures and requires trusted-local validation', () => {
    expect(
      rpcProcedureRequestPolicies.filter(({ demo }) => demo === 'synthetic-only').map(({ target }) => target),
    ).toEqual(['workThreads.list', 'workThreads.detail', 'workThreads.command']);

    for (const policy of requestPolicyMatrix) {
      expect(policy.trustedLocal).toBe('required');
      const observable = observableErrorFamiliesFor(policy);
      expect(observable.includes('ForbiddenDemo')).toBe(policy.demo === 'forbidden');
      expect(observable).toContain('MethodNotAllowed');
      expect(observable).toContain('MissingHost');
      expect(observable).toContain('UntrustedHost');
      expect(observable).toContain('ResponseTooLarge');
      for (const family of policy.applicationErrorFamilies) {
        expect(observable).toContain(family);
      }
      expect(observable.includes('CsrfRejected')).toBe(policy.csrf === 'required');
      expect(observable.includes('RequestTooLarge')).toBe(policy.requestSize !== 'none');
    }
  });

  test('keeps the operation-policy error vocabulary closed over the public contract families', () => {
    const policyErrors = sorted([
      ...new Set(requestPolicyMatrix.flatMap(({ applicationErrorFamilies }) => applicationErrorFamilies)),
    ]);

    expect(policyErrors).toEqual([
      'Conflict',
      'EngineUnavailable',
      'Forbidden',
      'ForbiddenDemo',
      'IncompatibleStore',
      'InvalidInput',
      'RevisionExpired',
      'SkillsConflict',
      'Unavailable',
    ]);
  });
});
