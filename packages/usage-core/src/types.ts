export type Rates = { in: number; out: number; cr: number; cw: number };

export interface Row {
  date: Date | null;
  endDate: Date | null;
  harness: string;
  provider: string;
  name: string;
  model: string;
  project: string;
  tokIn: number;
  tokOut: number;
  tokCr: number;
  tokCw: number;
  costActual: number | null;
  costApprox: number;
  costKnown: boolean;
  calls: number;
  durationMs: number | null;
  turns: number;
  tools: number;
  linesAdded: number | null;
  linesDeleted: number | null;
  rtkSavedTokens?: number;
  rtkInputTokens?: number;
  rtkOutputTokens?: number;
  rtkCommandCount?: number;
  subagent?: boolean;
  partial?: boolean;
  usageUnavailable?: boolean;
}
