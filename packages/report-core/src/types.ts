export interface Rates {
  cr: number;
  cw: number;
  in: number;
  out: number;
}

export interface UsageRowSource {
  harnessKey: string;
  machineId?: string;
  machineLabel?: string;
  sourcePath?: string | null;
  sourceSessionId: string | null;
}

export interface UsageRow {
  ambiguous?: boolean;
  calls: number;
  costActual: number | null;
  costApprox: number;
  costKnown: boolean;
  costQuota?: number | null;
  date: Date | null;
  durationMs: number | null;
  endDate: Date | null;
  harness: string;
  linesAdded: number | null;
  linesDeleted: number | null;
  model: string;
  models?: string[];
  name: string;
  partial?: boolean;
  project: string;
  provider: string;
  rtkCommandCount?: number;
  rtkInputTokens?: number;
  rtkOutputTokens?: number;
  rtkSavedTokens?: number;
  subagent?: boolean;
  tokCr: number;
  tokCw: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  turns: number;
  usageUnavailable?: boolean;
}

export type Row = UsageRow;

export type UsageRowWithOptionalSource = UsageRow & {
  source?: UsageRowSource;
};

export type CollectedUsageRow = UsageRow & {
  source: UsageRowSource;
};

export type SourcedRow = CollectedUsageRow;
