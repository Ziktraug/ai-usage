import { describe, expect, test } from 'bun:test';
import { actualCost, normalizeUsageRow } from './usage-row';
import {
  createUsageMergeBundle,
  mergeRowIdentity,
  parseUsageMergeBundle,
  toSerializedMergeRow,
} from './merge-bundle';

const machine = { id: 'machine-a', label: 'Machine A' };

const row = normalizeUsageRow({
  calls: 1,
  cost: actualCost(null),
  date: new Date('2026-06-01T10:00:00.000Z'),
  durationMs: 1000,
  endDate: new Date('2026-06-01T10:01:00.000Z'),
  harness: 'Codex',
  model: 'gpt-5',
  name: 'Session',
  project: 'ai-usage',
  provider: 'OpenAI',
  tokens: { in: 10, out: 20, cr: 0, cw: 5 },
});

describe('usage merge bundles', () => {
  test('serializes rows with required machine provenance and row hashes', () => {
    const bundle = createUsageMergeBundle({
      generatedAt: new Date('2026-06-19T12:00:00.000Z'),
      machine,
      rows: [{ ...row, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }],
    });

    expect(bundle.version).toBe(1);
    expect(bundle.rows).toHaveLength(1);
    expect(bundle.rows[0]?.source.machineId).toBe('machine-a');
    expect(bundle.rows[0]?.source.machineLabel).toBe('Machine A');
    expect(bundle.rows[0]?.rowKey).toBe('v1:machine-a:codex:session-1');
    expect(bundle.rows[0]?.contentHash).toHaveLength(64);
  });

  test('parses valid bundles and rejects invalid row provenance', () => {
    const bundle = createUsageMergeBundle({ machine, rows: [{ ...row }] });
    expect(parseUsageMergeBundle(JSON.stringify(bundle)).machine.id).toBe('machine-a');

    const invalid = { ...bundle, rows: [{ ...bundle.rows[0], source: { harnessKey: 'codex' } }] };
    expect(() => parseUsageMergeBundle(JSON.stringify(invalid))).toThrow('invalid rows');
  });

  test('keeps row keys stable while content hashes change with row content', () => {
    const first = toSerializedMergeRow({ ...row, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } }, machine);
    const updated = toSerializedMergeRow(
      { ...row, tokOut: row.tokOut + 1, source: { harnessKey: 'codex', sourceSessionId: 'session-1' } },
      machine,
    );

    expect(updated.rowKey).toBe(first.rowKey);
    expect(updated.contentHash).not.toBe(first.contentHash);
  });

  test('uses a deterministic fallback key when a source session id is absent', () => {
    const source = { harnessKey: 'codex', sourceSessionId: null, machineId: machine.id, machineLabel: machine.label };
    const identity = mergeRowIdentity(toSerializedMergeRow({ ...row }, machine), source);

    expect(identity.rowKey.startsWith('v1:machine-a:codex:')).toBe(true);
    expect(identity.sourceFingerprint).toHaveLength(64);
  });
});
