import { describe, expect, test } from 'bun:test';
import { createUsageSnapshot, mergeUsageSnapshots, parseUsageSnapshot } from './snapshot';
import type { Row } from './types';

const row = (name: string, sourceSessionId: string, overrides: Partial<Row> = {}): Row =>
  ({
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Codex',
    provider: 'Codex API',
    name,
    model: 'gpt-5.3-codex',
    project: 'ai-usage',
    tokIn: 10,
    tokOut: 5,
    tokCr: 0,
    tokCw: 0,
    costActual: 0.1,
    costApprox: 0.1,
    costKnown: true,
    calls: 1,
    durationMs: 60_000,
    turns: 1,
    tools: 0,
    linesAdded: null,
    linesDeleted: null,
    source: { harnessKey: 'codex', sourceSessionId },
    ...overrides,
  }) as Row;

const machine = { id: 'machine-1', label: 'Machine 1' };

describe('usage snapshots', () => {
  test('serializes rows with machine provenance', () => {
    const snapshot = createUsageSnapshot({ machine, rows: [row('a', 'session-1')] });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.rows[0]?.source).toMatchObject({
      machineId: 'machine-1',
      machineLabel: 'Machine 1',
      harnessKey: 'codex',
      sourceSessionId: 'session-1',
    });
  });

  test('parses and dedupes repeated snapshots by source session', () => {
    const older = createUsageSnapshot({
      machine,
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      rows: [row('older', 'session-1', { tokIn: 1 })],
    });
    const newer = createUsageSnapshot({
      machine,
      generatedAt: new Date('2026-01-01T00:05:00.000Z'),
      rows: [row('newer', 'session-1', { tokIn: 2 })],
    });

    const parsed = parseUsageSnapshot(JSON.stringify(older));
    const merged = mergeUsageSnapshots([parsed, newer]);

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]?.name).toBe('newer');
    expect(merged.duplicatesDropped).toBe(1);
    expect(merged.warnings).toHaveLength(1);
  });
});
