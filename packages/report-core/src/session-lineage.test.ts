import { describe, expect, test } from 'bun:test';
import { normalizeSessionLineage } from './session-lineage';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from './types';

const row = (sourceSessionId: string | null, overrides: Partial<CollectedUsageRow> = {}): CollectedUsageRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: sourceSessionId ?? 'missing-source',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 100,
  tokOut: 50,
  tokCr: 0,
  tokCw: 0,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 2,
  linesAdded: 1,
  linesDeleted: 0,
  source: {
    harnessKey: 'codex',
    sourceSessionId,
  },
  ...overrides,
});

describe('normalizeSessionLineage', () => {
  test('computes root ids for parent and child rows without mutating input order', () => {
    const parent = row('parent');
    const child = row('child', {
      source: { harnessKey: 'codex', sourceSessionId: 'child', parentSourceSessionId: 'parent' },
    });
    const rows = [child, parent];

    const normalized = normalizeSessionLineage(rows);

    expect(normalized.map((item) => item.source.sourceSessionId)).toEqual(['child', 'parent']);
    expect(normalized[0]?.source.rootSourceSessionId).toBe('parent');
    expect(normalized[1]?.source.rootSourceSessionId).toBe('parent');
    expect(normalized[0]).not.toBe(child);
    expect(normalized[0]?.source).not.toBe(child.source);
    expect(child.source.rootSourceSessionId).toBeUndefined();
  });

  test('uses the row id as root when the parent is absent', () => {
    const normalized = normalizeSessionLineage([
      row('child', { source: { harnessKey: 'codex', sourceSessionId: 'child', parentSourceSessionId: 'missing' } }),
    ]);

    expect(normalized[0]?.source.rootSourceSessionId).toBe('child');
  });

  test('uses the row id as root when a cycle is detected', () => {
    const normalized = normalizeSessionLineage([
      row('a', { source: { harnessKey: 'codex', sourceSessionId: 'a', parentSourceSessionId: 'b' } }),
      row('b', { source: { harnessKey: 'codex', sourceSessionId: 'b', parentSourceSessionId: 'a' } }),
    ]);

    expect(normalized[0]?.source.rootSourceSessionId).toBe('a');
    expect(normalized[1]?.source.rootSourceSessionId).toBe('b');
  });

  test('groups identity by machine and harness to avoid source id collisions', () => {
    const normalized = normalizeSessionLineage([
      row('parent', { source: { harnessKey: 'codex', sourceSessionId: 'parent', machineId: 'a' } }),
      row('child', {
        source: { harnessKey: 'codex', sourceSessionId: 'child', parentSourceSessionId: 'parent', machineId: 'b' },
      }),
      row('child', {
        source: { harnessKey: 'opencode', sourceSessionId: 'child', parentSourceSessionId: 'parent', machineId: 'a' },
      }),
    ]);

    expect(normalized[0]?.source.rootSourceSessionId).toBe('parent');
    expect(normalized[1]?.source.rootSourceSessionId).toBe('child');
    expect(normalized[2]?.source.rootSourceSessionId).toBe('child');
  });

  test('keeps source-less and null-source rows rootless', () => {
    const sourceLess: UsageRowWithOptionalSource = (({ source: _source, ...rest }) => rest)(row('source-less'));
    const nullSource: UsageRowWithOptionalSource = row(null);

    const normalized = normalizeSessionLineage([sourceLess, nullSource]);

    expect(normalized[0]).not.toBe(sourceLess);
    expect(normalized[0]?.source).toBeUndefined();
    expect(normalized[1]?.source?.rootSourceSessionId).toBeNull();
  });
});
