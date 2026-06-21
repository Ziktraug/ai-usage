import { describe, expect, test } from 'bun:test';
import { approximateApiCost, normalizeUsageRow, usageRowActiveDate, usageRowSessionLabel } from './usage-row';

describe('usage row', () => {
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
      cost: approximateApiCost,
      calls: 1,
    });

    expect(row.costKnown).toBe(true);
    expect(row.costApprox).toBeGreaterThan(0);
    expect(row.costActual).toBe(row.costApprox);
    expect(row.durationMs).toBe(120_000);
    expect(row.turns).toBe(0);
    expect(row.linesAdded).toBeNull();
  });

  test('prices OpenCode Go GLM models from public Z.AI rates', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:02:00.000Z'),
      harness: 'OpenCode',
      provider: 'opencode-go',
      name: 'fixture',
      model: 'opencode-go/glm-5.1',
      pricingModel: 'glm-5.1',
      tokens: { in: 1_000_000, out: 1_000_000, cr: 1_000_000, cw: 1_000_000 },
      cost: approximateApiCost,
      calls: 1,
    });

    expect(row.costKnown).toBe(true);
    expect(row.costApprox).toBeCloseTo(6.06, 5);
    expect(row.costActual).toBe(row.costApprox);
  });

  test('prices DeepSeek V4 Flash from public API rates', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:02:00.000Z'),
      harness: 'OpenCode',
      provider: 'DeepSeek API',
      name: 'fixture',
      model: 'deepseek/deepseek-v4-flash',
      pricingModel: 'deepseek-v4-flash',
      tokens: { in: 1_000_000, out: 1_000_000, cr: 1_000_000, cw: 1_000_000 },
      cost: approximateApiCost,
      calls: 1,
    });

    expect(row.costKnown).toBe(true);
    expect(row.costApprox).toBeCloseTo(0.5628, 5);
    expect(row.costActual).toBe(row.costApprox);
  });

  test('owns active date and marker labels', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:02:00.000Z'),
      harness: 'Cursor',
      provider: 'Cursor sub',
      name: 'fixture',
      model: 'cursor',
      tokens: { in: 1, out: 1, cr: 0, cw: 0 },
      cost: { _tag: 'ActualCost', amount: 0 },
      calls: 1,
      partial: true,
      subagent: true,
      usageUnavailable: true,
    });

    expect(usageRowActiveDate(row)?.toISOString()).toBe('2026-01-01T00:02:00.000Z');
    expect(usageRowSessionLabel(row)).toBe('fixture ~ ↳ (usage unavailable)');
  });
});
