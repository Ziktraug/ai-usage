export interface Rates {
  cr: number;
  cw: number;
  in: number;
  out: number;
}

export type TitleSource = 'ai' | 'first-prompt' | 'agent-role' | 'id';

export interface UsageRowSource {
  artifactPath?: string | null;
  harnessKey: string;
  machineId?: string;
  machineLabel?: string;
  parentSourceSessionId?: string | null;
  rootSourceSessionId?: string | null;
  sourcePath?: string | null;
  sourceSessionId: string | null;
}

/** Token and API-value attribution for one model within a usage row. */
export interface UsageModelSegment {
  /** Known API-value subtotal for this model; a lower bound when costKnown is false. */
  costApprox: number;
  /** True only when every token in this segment has known API pricing. */
  costKnown: boolean;
  model: string;
  tokCr: number;
  tokCw: number;
  tokIn: number;
  tokOut: number;
}

export interface UsageRow {
  ambiguous?: boolean;
  calls: number;
  costActual: number | null;
  /** Sum of segments with known API pricing; a lower bound when costKnown is false. */
  costApprox: number;
  /** True only when every token-bearing segment has known API pricing. */
  costKnown: boolean;
  costQuota?: number | null;
  date: Date | null;
  durationMs: number | null;
  endDate: Date | null;
  harness: string;
  linesAdded: number | null;
  linesDeleted: number | null;
  model: string;
  modelSegments?: UsageModelSegment[];
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
  titleSource?: TitleSource;
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
