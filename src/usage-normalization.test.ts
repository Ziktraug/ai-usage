import { describe, expect, test } from 'bun:test';
import { normalizeUsageRow } from './usage-normalization';

describe('usage normalization', () => {
  test('constructs report rows with pricing, defaults, and derived duration', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:02:00.000Z'),
      harness: 'Codex',
      provider: 'Codex API',
      name: 'fixture',
      model: 'gpt-5.3-codex',
      project: 'ai-usage',
      tokens: { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 },
      costActual: 'approx',
      calls: 1,
    });

    expect(row.costKnown).toBe(true);
    expect(row.costApprox).toBeGreaterThan(0);
    expect(row.costActual).toBe(row.costApprox);
    expect(row.durationMs).toBe(120_000);
    expect(row.turns).toBe(0);
    expect(row.linesAdded).toBeNull();
  });
});
