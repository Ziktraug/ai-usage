export type SessionQueryPerfPhase = 'count' | 'identity' | 'materialize' | 'projection';

export interface SessionQueryPerfPhaseStats {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly totalMs: number;
}

export interface SessionQueryPerfSnapshot {
  readonly phases: Record<SessionQueryPerfPhase, SessionQueryPerfPhaseStats>;
  readonly samples: number;
}

const EMPTY_PHASE: SessionQueryPerfPhaseStats = {
  count: 0,
  p50Ms: 0,
  p95Ms: 0,
  totalMs: 0,
};

const phaseSamples: Record<SessionQueryPerfPhase, number[]> = {
  count: [],
  identity: [],
  materialize: [],
  projection: [],
};

export const sessionQueryPerfEnabled = (): boolean =>
  process.env.AI_USAGE_PERF === '1' || process.env.AI_USAGE_PERF === 'true';

const percentile = (sorted: readonly number[], ratio: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
};

const summarizePhase = (samples: readonly number[]): SessionQueryPerfPhaseStats => {
  if (samples.length === 0) {
    return EMPTY_PHASE;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: samples.length,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    totalMs: Number(samples.reduce((sum, value) => sum + value, 0).toFixed(3)),
  };
};

export const recordSessionQueryPerfPhase = (phase: SessionQueryPerfPhase, durationMs: number): void => {
  if (!(sessionQueryPerfEnabled() && Number.isFinite(durationMs) && durationMs >= 0)) {
    return;
  }
  phaseSamples[phase].push(durationMs);
};

export const measureSessionQueryPerfPhase = <Value>(phase: SessionQueryPerfPhase, run: () => Value): Value => {
  if (!sessionQueryPerfEnabled()) {
    return run();
  }
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    recordSessionQueryPerfPhase(phase, performance.now() - startedAt);
  }
};

export const snapshotSessionQueryPerf = (): SessionQueryPerfSnapshot => ({
  phases: {
    count: summarizePhase(phaseSamples.count),
    identity: summarizePhase(phaseSamples.identity),
    materialize: summarizePhase(phaseSamples.materialize),
    projection: summarizePhase(phaseSamples.projection),
  },
  samples: phaseSamples.count.length + phaseSamples.materialize.length + phaseSamples.projection.length,
});

export const resetSessionQueryPerf = (): void => {
  phaseSamples.count.length = 0;
  phaseSamples.identity.length = 0;
  phaseSamples.materialize.length = 0;
  phaseSamples.projection.length = 0;
};
