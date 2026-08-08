import { describe, expect, test } from 'bun:test';
import {
  explicitHttpRequestPolicies,
  observableErrorFamiliesFor,
  operationRequestPolicies,
  requestPolicyMatrix,
} from './request-policy';
import { rpcPathByOperation } from './request-policy-handler';

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

describe('request policy matrix', () => {
  test('covers every live RPC path exactly once', () => {
    const liveOperationNames = Object.keys(rpcPathByOperation);
    const livePaths = Object.values(rpcPathByOperation);
    const rpcPolicyNames = operationRequestPolicies
      .filter(({ transport }) => transport !== 'file')
      .map(({ operation }) => operation);

    expect(new Set(liveOperationNames).size).toBe(liveOperationNames.length);
    expect(new Set(livePaths).size).toBe(livePaths.length);
    expect(new Set(rpcPolicyNames).size).toBe(rpcPolicyNames.length);
    expect(sorted(rpcPolicyNames)).toEqual(sorted(liveOperationNames));
  });

  test('keeps transport, method, CSRF, and size classes internally coherent', () => {
    for (const policy of operationRequestPolicies) {
      expect(policy.target.length).toBeGreaterThan(0);
      expect(policy.csrf).toBe(
        policy.transport === 'mutation' || policy.transport === 'file' ? 'required' : 'not-required',
      );

      if (policy.transport === 'file') {
        expect(policy.method).toBe('POST');
        expect(policy.requestSize).toBe('none');
        expect(policy.responseSize).toBe('portable-usage-json');
      } else {
        expect(policy.responseSize).toBe('bounded-json');
      }

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
    const byOperation = new Map(operationRequestPolicies.map((policy) => [policy.operation, policy]));

    expect(byOperation.get('refreshSkillManagementSnapshot')).toMatchObject({
      csrf: 'required',
      method: 'POST',
      transport: 'mutation',
    });
    expect(byOperation.get('getManagedSkillMarkdown')).toMatchObject({
      csrf: 'not-required',
      method: 'POST',
      transport: 'query',
    });
    expect(byOperation.get('getFocusedReportOverview')).toMatchObject({
      csrf: 'not-required',
      method: 'POST',
      transport: 'query',
    });
  });

  test('classifies every non-file operation as RPC and keeps file bytes out of RPC', () => {
    const rpcPolicies = operationRequestPolicies.filter(({ transport }) => transport !== 'file');
    const filePolicies = operationRequestPolicies.filter(({ transport }) => transport === 'file');

    expect(rpcPolicies).toHaveLength(Object.keys(rpcPathByOperation).length);
    expect(filePolicies).toEqual([
      expect.objectContaining({
        operation: 'exportManualMergeBundle',
        requestSize: 'none',
        responseSize: 'portable-usage-json',
        transport: 'file',
      }),
    ]);
  });

  test('freezes the explicit SSE, command, and upload classes with no route-policy bypass', () => {
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
        requestSize: 'portable-usage-json',
        transport: 'upload',
      }),
    ]);
  });

  test('requires demo rejection and trusted-local validation for every policy', () => {
    expect(requestPolicyMatrix).toHaveLength(33);
    expect(new Set(requestPolicyMatrix.map(({ id }) => id)).size).toBe(requestPolicyMatrix.length);

    for (const policy of requestPolicyMatrix) {
      expect(policy.demo).toBe('forbidden');
      expect(policy.trustedLocal).toBe('required');
      const observable = observableErrorFamiliesFor(policy);
      expect(observable).toContain('ForbiddenDemo');
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
      ...new Set(operationRequestPolicies.flatMap(({ applicationErrorFamilies }) => applicationErrorFamilies)),
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
