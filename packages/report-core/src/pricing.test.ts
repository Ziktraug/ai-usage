import { describe, expect, test } from 'bun:test';
import { approxCost, priceFor } from './pricing';
import type { Rates } from './types';

// Anchors the entries with no published change date, and the pre-cut leg of
// the GPT-5.6 schedules.
const REFERENCE_PRICE_DATE = new Date('2026-07-15T00:00:00.000Z');

const priceAt = (model: string, at = REFERENCE_PRICE_DATE) => priceFor(model, { at });

describe('model pricing', () => {
  test('prices current OpenAI models at their exact first-party rates', () => {
    const cases: [model: string, rates: Rates][] = [
      ['gpt-5.6', { in: 5, out: 30, cr: 0.5, cw: 6.25 }],
      ['gpt-5.6-sol', { in: 5, out: 30, cr: 0.5, cw: 6.25 }],
      ['gpt-5.6-terra', { in: 2.5, out: 15, cr: 0.25, cw: 3.125 }],
      ['gpt-5.6-luna', { in: 1, out: 6, cr: 0.1, cw: 1.25 }],
      ['gpt-6-astra', { in: 10, out: 50, cr: 1, cw: 12.5 }],
      ['gpt-5.5-pro', { in: 30, out: 180, cr: 30, cw: 30 }],
      ['gpt-5.5', { in: 5, out: 30, cr: 0.5, cw: 5 }],
      ['gpt-5.4-pro', { in: 30, out: 180, cr: 30, cw: 30 }],
      ['gpt-5.4-mini', { in: 0.75, out: 4.5, cr: 0.075, cw: 0.75 }],
      ['gpt-5.4-nano', { in: 0.2, out: 1.25, cr: 0.02, cw: 0.2 }],
      ['gpt-5.4', { in: 2.5, out: 15, cr: 0.25, cw: 2.5 }],
      ['gpt-5.3-codex', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
      ['gpt-5.2-codex', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
      ['gpt-5.2', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
      ['gpt-5.1-codex', { in: 1.25, out: 10, cr: 0.125, cw: 1.25 }],
      ['gpt-5-pro', { in: 15, out: 120, cr: 15, cw: 15 }],
      ['gpt-5-codex', { in: 1.25, out: 10, cr: 0.125, cw: 1.25 }],
      ['gpt-5', { in: 1.25, out: 10, cr: 0.125, cw: 1.25 }],
      ['o3-pro', { in: 20, out: 80, cr: 20, cw: 20 }],
      ['o3', { in: 2, out: 8, cr: 0.5, cw: 2 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }
  });

  test('prices current Anthropic models without collapsing legacy families', () => {
    const cases: [model: string, rates: Rates][] = [
      ['claude-fable-5-1', { in: 10, out: 50, cr: 0.25, cw: 12.5 }],
      ['claude-mythos-5-1', { in: 10, out: 50, cr: 0.25, cw: 12.5 }],
      ['claude-fable-5', { in: 10, out: 50, cr: 1, cw: 12.5 }],
      ['claude-mythos-5', { in: 10, out: 50, cr: 1, cw: 12.5 }],
      ['claude-opus-5', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
      ['claude-opus-4-8', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
      ['claude-opus-4-1', { in: 15, out: 75, cr: 1.5, cw: 18.75 }],
      ['claude-opus-4', { in: 15, out: 75, cr: 1.5, cw: 18.75 }],
      ['claude-sonnet-5', { in: 2, out: 10, cr: 0.2, cw: 2.5 }],
      ['claude-sonnet-4-6', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
      ['claude-sonnet-4', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
      ['claude-haiku-4-5', { in: 1, out: 5, cr: 0.1, cw: 1.25 }],
      ['claude-haiku-3-5', { in: 0.8, out: 4, cr: 0.08, cw: 1 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }
  });

  test('holds Sonnet 5 at the rate that became standard instead of the withdrawn increase', () => {
    const standard = { in: 2, out: 10, cr: 0.2, cw: 2.5 };
    for (const at of ['2026-08-31T23:59:59.999Z', '2026-09-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      expect(priceAt('claude-sonnet-5', new Date(at))).toEqual({ rates: standard, known: true });
    }
  });

  test('prices each GPT-5.6 model from the leg of its schedule in effect', () => {
    const cases: [model: string, at: string, rates: Rates][] = [
      ['gpt-5.6-sol', '2026-08-20T23:59:59.999Z', { in: 5, out: 30, cr: 0.5, cw: 6.25 }],
      ['gpt-5.6-sol', '2026-08-21T00:00:00.000Z', { in: 4, out: 20, cr: 0.4, cw: 5 }],
      ['gpt-5.6', '2026-08-21T00:00:00.000Z', { in: 4, out: 20, cr: 0.4, cw: 5 }],
      ['gpt-5.6-terra', '2026-07-29T23:59:59.999Z', { in: 2.5, out: 15, cr: 0.25, cw: 3.125 }],
      ['gpt-5.6-terra', '2026-07-30T00:00:00.000Z', { in: 2, out: 12, cr: 0.2, cw: 2.5 }],
      ['gpt-5.6-luna', '2026-07-29T23:59:59.999Z', { in: 1, out: 6, cr: 0.1, cw: 1.25 }],
      ['gpt-5.6-luna', '2026-07-30T00:00:00.000Z', { in: 0.2, out: 1.2, cr: 0.02, cw: 0.25 }],
    ];

    for (const [model, at, rates] of cases) {
      expect(priceAt(model, new Date(at))).toEqual({ rates, known: true });
    }
  });

  test('prices the OpenCode Zen free catalogue at zero without inventing a paid rate', () => {
    const free = { in: 0, out: 0, cr: 0, cw: 0 };
    for (const model of ['opencode/minimax-m2.5-free', 'opencode/glm-5-free', 'opencode-go/kimi-k2.5-free']) {
      expect(priceAt(model)).toEqual({ rates: free, known: true });
    }

    // The suffix only carries that meaning inside OpenCode Zen.
    expect(priceAt('openai/some-model-free').known).toBe(false);
  });

  test('prices DeepSeek aliases only while the provider supports them', () => {
    const flashRates = { in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 };
    expect(priceAt('deepseek-v4-flash')).toEqual({ rates: flashRates, known: true });
    expect(priceAt('deepseek-v4-pro')).toEqual({
      rates: { in: 0.435, out: 0.87, cr: 0.003_625, cw: 0.435 },
      known: true,
    });
    expect(priceAt('deepseek-chat', new Date('2026-07-24T15:58:59.999Z'))).toEqual({
      rates: flashRates,
      known: true,
    });
    expect(priceFor('deepseek-chat', { at: new Date('2026-07-24T15:59:00.000Z') }).known).toBe(false);
  });

  test('prices GLM text and vision models independently', () => {
    const cases: [model: string, rates: Rates][] = [
      ['glm-5.2', { in: 1.4, out: 4.4, cr: 0.26, cw: 0 }],
      ['glm-5v-turbo', { in: 1.2, out: 4, cr: 0.24, cw: 0 }],
      ['glm-4.6v', { in: 0.3, out: 0.9, cr: 0.05, cw: 0 }],
      ['glm-4.6v-flashx', { in: 0.04, out: 0.4, cr: 0.004, cw: 0 }],
      ['glm-4.5v', { in: 0.6, out: 1.8, cr: 0.11, cw: 0 }],
      ['glm-ocr', { in: 0.03, out: 0.03, cr: 0, cw: 0 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }

    expect(priceAt('glm-4.6v-flash')).toEqual({ rates: { in: 0, out: 0, cr: 0, cw: 0 }, known: true });
    expect(priceAt('glm-4.7-flash')).toEqual({ rates: { in: 0, out: 0, cr: 0, cw: 0 }, known: true });
  });

  test('prices supported paid-tier Gemini text models', () => {
    const cases: [model: string, rates: Rates][] = [
      ['gemini-3.5-flash', { in: 1.5, out: 9, cr: 0.15, cw: 1.5 }],
      ['gemini-3.1-flash-lite', { in: 0.25, out: 1.5, cr: 0.025, cw: 0.25 }],
      ['gemini-3.1-pro', { in: 2, out: 12, cr: 0.2, cw: 2 }],
      ['gemini-3.1-pro-preview', { in: 2, out: 12, cr: 0.2, cw: 2 }],
      ['gemini-3-flash-preview', { in: 0.5, out: 3, cr: 0.05, cw: 0.5 }],
      ['gemini-3-pro', { in: 2, out: 12, cr: 0.2, cw: 2 }],
      ['gemini-3-pro-preview', { in: 2, out: 12, cr: 0.2, cw: 2 }],
      ['gemini-2.5-pro', { in: 1.25, out: 10, cr: 0.125, cw: 1.25 }],
      ['gemini-2.5-flash', { in: 0.3, out: 2.5, cr: 0.03, cw: 0.3 }],
      ['gemini-2.5-flash-lite', { in: 0.1, out: 0.4, cr: 0.01, cw: 0.1 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }
  });

  test('prices current Kimi, Moonshot, and MiniMax models', () => {
    const cases: [model: string, rates: Rates][] = [
      ['kimi-k2.7-code', { in: 0.95, out: 4, cr: 0.19, cw: 0.95 }],
      ['kimi-k2.7-code-highspeed', { in: 1.9, out: 8, cr: 0.38, cw: 1.9 }],
      ['kimi-k2.6', { in: 0.95, out: 4, cr: 0.16, cw: 0.95 }],
      ['kimi-k2.5', { in: 0.6, out: 3, cr: 0.1, cw: 0.6 }],
      ['moonshot-v1-8k', { in: 0.2, out: 2, cr: 0, cw: 0.2 }],
      ['moonshot-v1-32k', { in: 1, out: 3, cr: 0, cw: 1 }],
      ['moonshot-v1-128k', { in: 2, out: 5, cr: 0, cw: 2 }],
      ['minimax-m3', { in: 0.3, out: 1.2, cr: 0.06, cw: 0.3 }],
      ['minimax-m2.7', { in: 0.3, out: 1.2, cr: 0.06, cw: 0.375 }],
      ['minimax-m2.7-highspeed', { in: 0.6, out: 2.4, cr: 0.06, cw: 0.375 }],
      ['minimax-m2.5', { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 }],
      ['minimax-m2.1', { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 }],
      ['minimax-m2', { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }
  });

  test('normalizes provider prefixes, snapshots, aliases, and operational variants', () => {
    const cases: [model: string, rates: Rates][] = [
      ['openai/gpt-5.6-luna-2026-07-09', { in: 1, out: 6, cr: 0.1, cw: 1.25 }],
      ['cursor/claude-opus-4-8-thinking-high', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
      ['claude-haiku-4-5-20251001', { in: 1, out: 5, cr: 0.1, cw: 1.25 }],
      ['claude-4.5-sonnet', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
      ['cursor/claude-4-sonnet-thinking', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
      ['claude-4-opus-thinking', { in: 15, out: 75, cr: 1.5, cw: 18.75 }],
      ['composer-2.5', { in: 0.5, out: 2.5, cr: 0.2, cw: 0.5 }],
      ['composer-2.5-fast', { in: 3, out: 15, cr: 0.5, cw: 3 }],
      ['grok-code-fast-1', { in: 0.2, out: 1.5, cr: 0.02, cw: 0.2 }],
      ['gemini-3.1-pro-preview-customtools', { in: 2, out: 12, cr: 0.2, cw: 2 }],
      ['moonshot-v1-32k-vision-preview', { in: 1, out: 3, cr: 0, cw: 1 }],
      ['MiniMax-M2.7-highspeed', { in: 0.6, out: 2.4, cr: 0.06, cw: 0.375 }],
    ];

    for (const [model, rates] of cases) {
      expect(priceAt(model)).toEqual({ rates, known: true });
    }
  });

  test('keeps unpublished, discontinued, and modality-dependent models unknown', () => {
    const models = [
      '',
      // Hidden Codex routing alias: its catalogue entry carries model: null and
      // the backend may route it differently over time, so it has no billable
      // identity to join a price to.
      'codex-auto-review',
      // Stealth and retired first-party models with no published rate.
      'big-pickle',
      'cheetah',
      'code-supernova',
      'composer-2',
      'gpt-5.3',
      'claude-mythos-preview',
      'gemini-3.1-flash-live-preview',
      'kimi-k2-thinking',
      'kimi-k3',
      'glm',
    ];

    for (const model of models) {
      expect(priceFor(model, { at: REFERENCE_PRICE_DATE })).toEqual({
        rates: { in: 0, out: 0, cr: 0, cw: 0 },
        known: false,
      });
    }
  });

  test('calculates a blended token cost from resolved rates', () => {
    const { rates } = priceFor('gpt-5.6-terra', { at: REFERENCE_PRICE_DATE });
    expect(approxCost(rates, { in: 1_000_000, out: 1_000_000, cr: 1_000_000, cw: 1_000_000 })).toBe(20.875);
  });
});
