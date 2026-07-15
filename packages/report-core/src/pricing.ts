import { parseModelIdentity } from './model-identity';
import type { Rates } from './types';

export interface PricingContext {
  /** Session/request time used for prices with a published validity window. */
  at?: Date | null;
}

const UNKNOWN: Rates = { in: 0, out: 0, cr: 0, cw: 0 };
const FREE: Rates = { in: 0, out: 0, cr: 0, cw: 0 };
const SONNET_5_PROMOTIONAL_RATES: Rates = { in: 2, out: 10, cr: 0.2, cw: 2.5 };
const SONNET_5_STANDARD_RATES: Rates = { in: 3, out: 15, cr: 0.3, cw: 3.75 };

// Standard first-party pay-as-you-go text-token prices in USD per 1M tokens.
// `cw` is the cache-creation rate when one is published. Otherwise it is the
// ordinary input rate when cache-write tokens are reported separately, or zero
// for providers that explicitly do not bill cache creation tokens.
const PRICING: Readonly<Record<string, Rates>> = {
  // OpenAI
  'gpt-5.6-sol': { in: 5, out: 30, cr: 0.5, cw: 6.25 },
  'gpt-5.6-terra': { in: 2.5, out: 15, cr: 0.25, cw: 3.125 },
  'gpt-5.6-luna': { in: 1, out: 6, cr: 0.1, cw: 1.25 },
  'gpt-5.5-pro': { in: 30, out: 180, cr: 30, cw: 30 },
  'gpt-5.5': { in: 5, out: 30, cr: 0.5, cw: 5 },
  'gpt-5.4-pro': { in: 30, out: 180, cr: 30, cw: 30 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5, cr: 0.075, cw: 0.75 },
  'gpt-5.4-nano': { in: 0.2, out: 1.25, cr: 0.02, cw: 0.2 },
  'gpt-5.4': { in: 2.5, out: 15, cr: 0.25, cw: 2.5 },
  'gpt-5.3-codex': { in: 1.75, out: 14, cr: 0.175, cw: 1.75 },
  'gpt-5.2': { in: 1.75, out: 14, cr: 0.175, cw: 1.75 },
  'gpt-5.1-codex': { in: 1.25, out: 10, cr: 0.125, cw: 1.25 },
  'gpt-5': { in: 1.25, out: 10, cr: 0.125, cw: 1.25 },

  // Anthropic
  'claude-fable-5': { in: 10, out: 50, cr: 1, cw: 12.5 },
  'claude-mythos-5': { in: 10, out: 50, cr: 1, cw: 12.5 },
  'claude-opus-4-8': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-7': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-6': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-5': { in: 5, out: 25, cr: 0.5, cw: 6.25 },
  'claude-opus-4-1': { in: 15, out: 75, cr: 1.5, cw: 18.75 },
  'claude-sonnet-5': SONNET_5_PROMOTIONAL_RATES,
  'claude-sonnet-4-6': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-sonnet-4-5': { in: 3, out: 15, cr: 0.3, cw: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1, cw: 1.25 },
  'claude-haiku-3-5': { in: 0.8, out: 4, cr: 0.08, cw: 1 },

  // DeepSeek
  'deepseek-v4-flash': { in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 },
  'deepseek-v4-pro': { in: 0.435, out: 0.87, cr: 0.003_625, cw: 0.435 },

  // Z.AI / GLM text
  'glm-5.2': { in: 1.4, out: 4.4, cr: 0.26, cw: 0 },
  'glm-5.1': { in: 1.4, out: 4.4, cr: 0.26, cw: 0 },
  'glm-5-turbo': { in: 1.2, out: 4, cr: 0.24, cw: 0 },
  'glm-5': { in: 1, out: 3.2, cr: 0.2, cw: 0 },
  'glm-4.7-flashx': { in: 0.07, out: 0.4, cr: 0.01, cw: 0 },
  'glm-4.7-flash': FREE,
  'glm-4.7': { in: 0.6, out: 2.2, cr: 0.11, cw: 0 },
  'glm-4.6': { in: 0.6, out: 2.2, cr: 0.11, cw: 0 },
  'glm-4.5-airx': { in: 1.1, out: 4.5, cr: 0.22, cw: 0 },
  'glm-4.5-air': { in: 0.2, out: 1.1, cr: 0.03, cw: 0 },
  'glm-4.5-flash': FREE,
  'glm-4.5-x': { in: 2.2, out: 8.9, cr: 0.45, cw: 0 },
  'glm-4.5': { in: 0.6, out: 2.2, cr: 0.11, cw: 0 },
  'glm-4-32b-0414-128k': { in: 0.1, out: 0.1, cr: 0, cw: 0 },

  // Z.AI / GLM vision-language
  'glm-5v-turbo': { in: 1.2, out: 4, cr: 0.24, cw: 0 },
  'glm-4.6v-flashx': { in: 0.04, out: 0.4, cr: 0.004, cw: 0 },
  'glm-4.6v-flash': FREE,
  'glm-4.6v': { in: 0.3, out: 0.9, cr: 0.05, cw: 0 },
  'glm-4.5v': { in: 0.6, out: 1.8, cr: 0.11, cw: 0 },
  'glm-ocr': { in: 0.03, out: 0.03, cr: 0, cw: 0 },

  // Google Gemini Developer API. Context-cache storage is not included.
  'gemini-3.5-flash': { in: 1.5, out: 9, cr: 0.15, cw: 1.5 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5, cr: 0.025, cw: 0.25 },
  'gemini-3.1-pro-preview': { in: 2, out: 12, cr: 0.2, cw: 2 },
  'gemini-3-flash-preview': { in: 0.5, out: 3, cr: 0.05, cw: 0.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10, cr: 0.125, cw: 1.25 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cr: 0.03, cw: 0.3 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4, cr: 0.01, cw: 0.1 },

  // Moonshot AI / Kimi
  'kimi-k2.7-code-highspeed': { in: 1.9, out: 8, cr: 0.38, cw: 1.9 },
  'kimi-k2.7-code': { in: 0.95, out: 4, cr: 0.19, cw: 0.95 },
  'kimi-k2.6': { in: 0.95, out: 4, cr: 0.16, cw: 0.95 },
  'kimi-k2.5': { in: 0.6, out: 3, cr: 0.1, cw: 0.6 },
  'moonshot-v1-8k': { in: 0.2, out: 2, cr: 0, cw: 0.2 },
  'moonshot-v1-32k': { in: 1, out: 3, cr: 0, cw: 1 },
  'moonshot-v1-128k': { in: 2, out: 5, cr: 0, cw: 2 },

  // MiniMax
  'minimax-m3': { in: 0.3, out: 1.2, cr: 0.06, cw: 0.3 },
  'minimax-m2.7-highspeed': { in: 0.6, out: 2.4, cr: 0.06, cw: 0.375 },
  'minimax-m2.7': { in: 0.3, out: 1.2, cr: 0.06, cw: 0.375 },
  'minimax-m2.5-highspeed': { in: 0.6, out: 2.4, cr: 0.03, cw: 0.375 },
  'minimax-m2.5': { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 },
  'minimax-m2.1-highspeed': { in: 0.6, out: 2.4, cr: 0.03, cw: 0.375 },
  'minimax-m2.1': { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 },
  'minimax-m2': { in: 0.3, out: 1.2, cr: 0.03, cw: 0.375 },
};

const ALIASES: Readonly<Record<string, string>> = {
  'gpt-5.6': 'gpt-5.6-sol',
  'claude-4.8-opus': 'claude-opus-4-8',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-4.7-opus': 'claude-opus-4-7',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-4.6-opus': 'claude-opus-4-6',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-4.5-opus': 'claude-opus-4-5',
  'claude-opus-4.5': 'claude-opus-4-5',
  'claude-4.1-opus': 'claude-opus-4-1',
  'claude-opus-4.1': 'claude-opus-4-1',
  'claude-4.6-sonnet': 'claude-sonnet-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-4.5-sonnet': 'claude-sonnet-4-5',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-4.5-haiku': 'claude-haiku-4-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-3.5-haiku': 'claude-haiku-3-5',
  'claude-haiku-3.5': 'claude-haiku-3-5',
  'gemini-3.1-pro-preview-customtools': 'gemini-3.1-pro-preview',
  'gemini-2.5-flash-lite-preview-09-2025': 'gemini-2.5-flash-lite',
  'moonshot-v1-8k-vision-preview': 'moonshot-v1-8k',
  'moonshot-v1-32k-vision-preview': 'moonshot-v1-32k',
  'moonshot-v1-128k-vision-preview': 'moonshot-v1-128k',
};

const OPENAI_SNAPSHOT_SUFFIX = /-20\d{2}-\d{2}-\d{2}$/;
const CLAUDE_SNAPSHOT_SUFFIX = /-20\d{6}$/;
const SONNET_5_STANDARD_PRICE_AT = Date.parse('2026-09-01T00:00:00.000Z');
const DEEPSEEK_COMPATIBILITY_ALIASES_END_AT = Date.parse('2026-07-24T15:59:00.000Z');

const resolveDirectPricingId = (candidate: string): string | null => {
  const aliased = ALIASES[candidate] ?? candidate;
  return PRICING[aliased] ? aliased : null;
};

const resolvePricingId = (model: string): string | null => {
  const identity = parseModelIdentity(model);
  const candidates = [identity.canonicalId, identity.baseId];

  for (const candidate of candidates) {
    const directId = resolveDirectPricingId(candidate);
    if (directId) {
      return directId;
    }

    const withoutSnapshot = candidate.replace(OPENAI_SNAPSHOT_SUFFIX, '').replace(CLAUDE_SNAPSHOT_SUFFIX, '');
    const snapshotId = resolveDirectPricingId(withoutSnapshot);
    if (snapshotId) {
      return snapshotId;
    }
  }

  return null;
};

const timestampFor = (context?: PricingContext): number => {
  const timestamp = context?.at?.getTime();
  return timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : Date.now();
};

export const priceFor = (model: string, context?: PricingContext): { rates: Rates; known: boolean } => {
  const identity = parseModelIdentity(model);
  const timestamp = timestampFor(context);

  if (identity.baseId === 'deepseek-chat' || identity.baseId === 'deepseek-reasoner') {
    if (timestamp < DEEPSEEK_COMPATIBILITY_ALIASES_END_AT) {
      return { rates: PRICING['deepseek-v4-flash'] ?? UNKNOWN, known: true };
    }
    return { rates: UNKNOWN, known: false };
  }

  const pricingId = resolvePricingId(model);
  if (pricingId === 'claude-sonnet-5') {
    const rates = timestamp < SONNET_5_STANDARD_PRICE_AT ? SONNET_5_PROMOTIONAL_RATES : SONNET_5_STANDARD_RATES;
    return { rates, known: true };
  }

  if (!pricingId) {
    return { rates: UNKNOWN, known: false };
  }

  const rates = PRICING[pricingId];
  return rates ? { rates, known: true } : { rates: UNKNOWN, known: false };
};

export const approxCost = (rates: Rates, tokens: { in: number; out: number; cr: number; cw: number }) =>
  (tokens.in * rates.in + tokens.out * rates.out + tokens.cr * rates.cr + tokens.cw * rates.cw) / 1_000_000;
