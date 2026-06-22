import type { Rates } from './types';

const UNKNOWN: Rates = { in: 0, out: 0, cr: 0, cw: 0 };
const FREE: Rates = { in: 0, out: 0, cr: 0, cw: 0 };

const PRICING: [string, Rates][] = [
  ['opus-4-8', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['opus-4-7', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['opus-4-6', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['opus-4-5', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['fable', { in: 10, out: 50, cr: 1.0, cw: 12.5 }],
  ['sonnet', { in: 3, out: 15, cr: 0.3, cw: 3.75 }],
  ['haiku', { in: 1, out: 5, cr: 0.1, cw: 1.25 }],
  ['opus', { in: 5, out: 25, cr: 0.5, cw: 6.25 }],
  ['gpt-5.5', { in: 5, out: 30, cr: 0.5, cw: 5 }],
  ['gpt-5.4', { in: 2.5, out: 15, cr: 0.25, cw: 2.5 }],
  ['gpt-5.3-codex', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
  ['gpt-5.1-codex', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
  ['codex', { in: 1.75, out: 14, cr: 0.175, cw: 1.75 }],
  ['gpt-5.3', { in: 2.5, out: 15, cr: 0.25, cw: 2.5 }],
  ['gpt-5.1', { in: 2.5, out: 15, cr: 0.25, cw: 2.5 }],
  ['gpt-5', { in: 2.5, out: 15, cr: 0.25, cw: 2.5 }],
  ['deepseek-v4-flash', { in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 }],
  ['deepseek-chat', { in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 }],
  ['deepseek-reasoner', { in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 }],
  ['glm-5.2', { in: 1.4, out: 4.4, cr: 0.26, cw: 0 }],
  ['glm-5.1', { in: 1.4, out: 4.4, cr: 0.26, cw: 0 }],
  ['glm-5-turbo', { in: 1.2, out: 4.0, cr: 0.24, cw: 0 }],
  ['glm-5', { in: 1, out: 3.2, cr: 0.2, cw: 0 }],
  ['glm-4.7-flashx', { in: 0.07, out: 0.4, cr: 0.01, cw: 0 }],
  ['glm-4.7-flash', FREE],
  ['glm-4.7', { in: 0.6, out: 2.2, cr: 0.11, cw: 0 }],
  ['glm-4.6', { in: 0.6, out: 2.2, cr: 0.11, cw: 0 }],
  ['glm-4.5-airx', { in: 1.1, out: 4.5, cr: 0.22, cw: 0 }],
  ['glm-4.5-air', { in: 0.2, out: 1.1, cr: 0.03, cw: 0 }],
  ['glm-4.5-flash', FREE],
  ['glm-4.5-x', { in: 2.2, out: 8.9, cr: 0.45, cw: 0 }],
  ['glm-4.5', { in: 0.6, out: 2.2, cr: 0.11, cw: 0 }],
  ['glm-4-32b-0414-128k', { in: 0.1, out: 0.1, cr: 0, cw: 0 }],
  ['big-pickle', UNKNOWN],
  ['glm', UNKNOWN],
  ['minimax', UNKNOWN],
  ['kimi', UNKNOWN],
  ['gemini', UNKNOWN],
];

export const priceFor = (model: string): { rates: Rates; known: boolean } => {
  const m = (model || '').toLowerCase();
  for (const [key, rates] of PRICING) {
    if (m.includes(key)) {
      return { rates, known: rates !== UNKNOWN };
    }
  }
  return { rates: UNKNOWN, known: false };
};

export const approxCost = (rates: Rates, tokens: { in: number; out: number; cr: number; cw: number }) =>
  (tokens.in * rates.in + tokens.out * rates.out + tokens.cr * rates.cr + tokens.cw * rates.cw) / 1_000_000;
