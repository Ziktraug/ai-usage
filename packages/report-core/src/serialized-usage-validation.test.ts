import { describe, expect, test } from 'bun:test';
import { isSerializedMergeRow, toSerializedMergeRow, usageContentHash } from './merge-bundle';
import {
  isSerializedUsageRowSource,
  isSerializedUsageRowWithSource,
  serializedUsageRowSourceValidationReason,
} from './serialized-usage-validation';
import { actualCost, normalizeUsageRow } from './usage-row';

const source = {
  harnessKey: 'claude',
  machineId: 'synthetic-machine',
  machineLabel: 'Synthetic machine',
  sourceSessionId: 'synthetic-parent',
};

const serialized = toSerializedMergeRow(
  {
    ...normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
      harness: 'Claude Code',
      model: 'synthetic-model',
      name: 'Synthetic session',
      provider: 'Anthropic',
      tokens: { in: 1, out: 2, cr: 0, cw: 0 },
    }),
    source,
  },
  { id: source.machineId, label: source.machineLabel },
);

const storedWithDelegations = (delegatedSessions: unknown) => {
  const { contentHash: _contentHash, ...content } = serialized;
  const updated = { ...content, source: { ...source, delegatedSessions } };
  return { ...updated, contentHash: usageContentHash(updated) };
};

describe('serialized source delegation facts', () => {
  test('keeps old stored rows without delegation facts valid', () => {
    expect(isSerializedUsageRowSource(source)).toBe(true);
    expect(serializedUsageRowSourceValidationReason(source)).toBeNull();
    expect(isSerializedMergeRow(serialized)).toBe(true);
    expect(isSerializedUsageRowSource({ ...source, parentSourceSessionId: null, sourcePath: null })).toBe(true);
    const {
      contentHash: _contentHash,
      rowKey: _rowKey,
      sourceFingerprint: _fingerprint,
      status: _status,
      ...row
    } = serialized;
    expect(isSerializedUsageRowWithSource(row)).toBe(true);
  });

  test('accepts declared Codex delegations on stored rows without changing their stable identity', () => {
    const delegatedSessions = [{ harness: 'codex', sourceSessionId: '00000000-0000-4000-8000-000000000001' }];
    const stored = storedWithDelegations(delegatedSessions);
    expect(isSerializedUsageRowSource(stored.source)).toBe(true);
    expect(serializedUsageRowSourceValidationReason(stored.source)).toBeNull();
    expect(isSerializedMergeRow(stored)).toBe(true);
    expect(stored.rowKey).toBe(serialized.rowKey);
    expect(stored.contentHash).not.toBe(serialized.contentHash);
  });

  test('leaves collection limits and deduplication to the producer', () => {
    expect(isSerializedUsageRowSource({ ...source, delegatedSessions: [] })).toBe(true);
    const delegatedSessions = Array.from({ length: 33 }, () => ({ harness: 'codex', sourceSessionId: 'same-id' }));
    expect(isSerializedMergeRow(storedWithDelegations(delegatedSessions))).toBe(true);
  });

  test.each([
    ['wrong harness', [{ harness: 'claude', sourceSessionId: 'child' }]],
    ['non-string id', [{ harness: 'codex', sourceSessionId: 42 }]],
    ['missing id', [{ harness: 'codex' }]],
    ['null list', null],
    ['object instead of list', { harness: 'codex', sourceSessionId: 'child' }],
    ['null entry', [null]],
    ['unknown entry field', [{ harness: 'codex', sourceSessionId: 'child', guessed: true }]],
  ])('rejects %s with a typed delegation reason', (_label, delegatedSessions) => {
    const stored = storedWithDelegations(delegatedSessions);
    expect(isSerializedUsageRowSource(stored.source)).toBe(false);
    expect(serializedUsageRowSourceValidationReason(stored.source)).toBe('invalid-delegated-sessions');
    expect(isSerializedMergeRow(stored)).toBe(false);
  });

  test('retains the rejection of unrelated invalid source fields', () => {
    expect(serializedUsageRowSourceValidationReason(null)).toBe('invalid-source');
    expect(serializedUsageRowSourceValidationReason({ ...source, machineId: '' })).toBe('invalid-source');
    expect(serializedUsageRowSourceValidationReason({ ...source, unrelated: true })).toBe('invalid-source');
  });
});
