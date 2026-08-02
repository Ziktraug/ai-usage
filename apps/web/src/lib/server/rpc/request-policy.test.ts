import { describe, expect, test } from 'bun:test';
import type { OperationDescriptor, ParityRecord, ParityShard } from '../../../../migration-parity/schema';
import v1Shard from '../../../../migration-parity/shards/v1.parity';
import v2Shard from '../../../../migration-parity/shards/v2.parity';
import v3Shard from '../../../../migration-parity/shards/v3.parity';
import v4Shard from '../../../../migration-parity/shards/v4.parity';
import {
  explicitHttpRequestPolicies,
  observableErrorFamiliesFor,
  operationRequestPolicies,
  requestPolicyMatrix,
} from './request-policy';

interface FrozenOperation {
  readonly descriptor: OperationDescriptor;
  readonly name: string;
}

const frozenShards: readonly ParityShard[] = [v1Shard, v2Shard, v3Shard, v4Shard];

const isOperationRecord = (
  record: ParityRecord,
): record is ParityRecord & { readonly operation: OperationDescriptor } =>
  record.kind === 'operation' && record.id.startsWith('op:') && record.operation !== undefined;

const frozenOperations = frozenShards.flatMap((shard) =>
  shard.records.filter(isOperationRecord).map(
    (record): FrozenOperation => ({
      descriptor: record.operation,
      name: record.id.slice('op:'.length),
    }),
  ),
);

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

describe('request policy matrix', () => {
  test('covers every frozen V1-V4 operation exactly once without importing an implementation', () => {
    const frozenNames = frozenOperations.map(({ name }) => name);
    const policyNames = operationRequestPolicies.map(({ operation }) => operation);

    expect(frozenNames).toHaveLength(30);
    expect(new Set(frozenNames).size).toBe(30);
    expect(policyNames).toHaveLength(30);
    expect(new Set(policyNames).size).toBe(30);
    expect(sorted(policyNames)).toEqual(sorted(frozenNames));
  });

  test('freezes transport, target, public errors, method normalization, and size classes from the inventory', () => {
    const policiesByOperation = new Map(operationRequestPolicies.map((policy) => [policy.operation, policy]));

    for (const { descriptor, name } of frozenOperations) {
      const policy = policiesByOperation.get(name);
      expect(policy).toBeDefined();
      if (!policy) {
        continue;
      }

      expect(policy.target).toBe(descriptor.target);
      expect(policy.transport).toBe(descriptor.transport);
      expect(sorted(policy.applicationErrorFamilies)).toEqual(sorted(descriptor.publicErrors));
      expect(policy.method).toBe(descriptor.transport === 'mutation' ? 'POST' : descriptor.currentMethod);
      expect(policy.csrf).toBe(
        descriptor.transport === 'mutation' || descriptor.transport === 'file' ? 'required' : 'not-required',
      );

      if (descriptor.transport === 'file') {
        expect(policy.requestSize).toBe('none');
        expect(policy.responseSize).toBe('portable-usage-json');
      } else if (descriptor.inputParser === 'none') {
        expect(policy.requestSize).toBe('none');
      } else {
        expect(policy.requestSize).toBe(policy.method === 'GET' ? 'bounded-url' : 'bounded-rpc-json');
      }
      expect(policy.responseSize).toBe(descriptor.transport === 'file' ? 'portable-usage-json' : 'bounded-json');
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

    expect(rpcPolicies).toHaveLength(29);
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

  test('keeps the inventory error vocabulary closed over the public contract families', () => {
    const inventoryErrors = sorted([...new Set(frozenOperations.flatMap(({ descriptor }) => descriptor.publicErrors))]);

    expect(inventoryErrors).toEqual([
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
