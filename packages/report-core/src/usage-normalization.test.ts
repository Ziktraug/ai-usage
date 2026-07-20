import { describe, expect, test } from 'bun:test';
import {
  actualCost,
  approximateApiCost,
  MAX_USAGE_MODEL_SEGMENTS,
  normalizeUsageRow,
  UNSEGMENTED_MULTI_MODEL_LABEL,
  usageRowActiveDate,
  usageRowSessionLabel,
} from './usage-row';

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

  test('nulls durations where the end precedes the start', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-04-01T13:40:17.105Z'),
      endDate: new Date('2026-04-01T13:40:05.651Z'),
      harness: 'Cursor',
      provider: 'Cursor sub',
      name: 'reversed timestamps',
      model: 'cursor',
      tokens: { in: 1, out: 1, cr: 0, cw: 0 },
      cost: { _tag: 'ActualCost', amount: 0 },
      calls: 1,
    });

    expect(row.durationMs).toBeNull();
  });

  test('preserves an explicitly unavailable duration instead of deriving the event span', () => {
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: new Date('2026-04-01T13:40:00.000Z'),
      durationMs: null,
      endDate: new Date('2026-04-01T13:42:00.000Z'),
      harness: 'Claude',
      model: 'claude-sonnet',
      name: 'untimed session',
      provider: 'Anthropic API',
      tokens: { in: 1, out: 1, cr: 0, cw: 0 },
    });

    expect(row.durationMs).toBeNull();
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

  test('uses the session date for prices with a validity window', () => {
    const row = normalizeUsageRow({
      date: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-01T00:02:00.000Z'),
      harness: 'Claude',
      provider: 'Anthropic API',
      name: 'fixture',
      model: 'claude-sonnet-5',
      tokens: { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 },
      cost: approximateApiCost,
      calls: 1,
    });

    expect(row.costKnown).toBe(true);
    expect(row.costApprox).toBe(18);
  });

  test('keeps a partial API-value lower bound without claiming exact API spend', () => {
    const input = {
      calls: 2,
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:02:00.000Z'),
      harness: 'Codex',
      model: 'gpt-5.4',
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 0,
          tokCw: 0,
          tokIn: 10,
          tokOut: 0,
        },
        {
          costApprox: 0,
          costKnown: false,
          model: 'private-model',
          tokCr: 0,
          tokCw: 0,
          tokIn: 0,
          tokOut: 10,
        },
      ],
      name: 'partial pricing',
      project: 'ai-usage',
      provider: 'Codex API',
      tokens: { cr: 0, cw: 0, in: 0, out: 0 },
    };

    const apiRow = normalizeUsageRow({ ...input, cost: approximateApiCost });
    const subscriptionRow = normalizeUsageRow({ ...input, cost: actualCost(0) });

    expect(apiRow.costApprox).toBe(2);
    expect(apiRow.costKnown).toBe(false);
    expect(apiRow.costActual).toBeNull();
    expect(subscriptionRow.costActual).toBe(0);
  });

  test('bounds model segments without losing overflow usage or the dominant model', () => {
    const modelSegments = Array.from({ length: 66 }, (_, index) => ({
      costApprox: 1,
      costKnown: index !== 64,
      model: `model-${index}`,
      tokCr: 0,
      tokCw: 0,
      tokIn: 1,
      tokOut: 0,
    }));
    const row = normalizeUsageRow({
      calls: 1,
      cost: approximateApiCost,
      date: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-01-01T00:01:00.000Z'),
      harness: 'Codex',
      model: 'model-65',
      modelSegments,
      models: modelSegments.map((segment) => segment.model),
      name: 'many models',
      project: 'ai-usage',
      provider: 'Codex API',
      tokens: { cr: 0, cw: 0, in: 0, out: 0 },
    });

    expect(MAX_USAGE_MODEL_SEGMENTS).toBe(64);
    expect(row.modelSegments).toHaveLength(64);
    expect(row.model).toBe('model-65');
    expect(row.models).toEqual(row.modelSegments?.map((segment) => segment.model));
    expect(row.modelSegments?.at(-1)).toEqual({
      costApprox: 3,
      costKnown: false,
      model: UNSEGMENTED_MULTI_MODEL_LABEL,
      tokCr: 0,
      tokCw: 0,
      tokIn: 3,
      tokOut: 0,
    });
    expect({ costApprox: row.costApprox, costKnown: row.costKnown, tokIn: row.tokIn }).toEqual({
      costApprox: 66,
      costKnown: false,
      tokIn: 66,
    });
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
