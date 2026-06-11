import { approxCost, priceFor } from './pricing';
import type { Row } from './types';

export type TokenCounts = { in: number; out: number; cr: number; cw: number };
export type ActualCost = number | null | 'approx';

export interface UsageRowInput {
  date: Date | null;
  endDate: Date | null;
  harness: string;
  provider: string;
  name: string;
  model: string;
  pricingModel?: string;
  project?: string | null;
  tokens: TokenCounts;
  costActual: ActualCost;
  calls: number;
  durationMs?: number | null;
  turns?: number;
  tools?: number;
  linesAdded?: number | null;
  linesDeleted?: number | null;
  subagent?: boolean;
  partial?: boolean;
}

export const tokenTotal = (tokens: TokenCounts) => tokens.in + tokens.out + tokens.cr + tokens.cw;

export const normalizeUsageRow = (input: UsageRowInput): Row => {
  const { rates, known } = priceFor(input.pricingModel ?? input.model);
  const costApprox = approxCost(rates, input.tokens);
  const durationMs =
    input.durationMs ?? (input.date && input.endDate ? input.endDate.getTime() - input.date.getTime() : null);

  return {
    date: input.date,
    endDate: input.endDate,
    harness: input.harness,
    provider: input.provider,
    name: input.name,
    model: input.model,
    project: input.project ?? '',
    tokIn: input.tokens.in,
    tokOut: input.tokens.out,
    tokCr: input.tokens.cr,
    tokCw: input.tokens.cw,
    costActual: input.costActual === 'approx' ? costApprox : input.costActual,
    costApprox,
    costKnown: known,
    calls: input.calls,
    durationMs,
    turns: input.turns ?? 0,
    tools: input.tools ?? 0,
    linesAdded: input.linesAdded ?? null,
    linesDeleted: input.linesDeleted ?? null,
    ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
    ...(input.partial === undefined ? {} : { partial: input.partial }),
  };
};
