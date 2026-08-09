export interface SessionQueryExactRevisionCache<Totals, Projection> {
  projection(identity: string): Projection | undefined;
  rememberProjection(identity: string, projection: Projection): void;
  rememberTotals(identity: string, totals: Totals): void;
  reset(): void;
  totals(identity: string): Totals | undefined;
}

interface SessionQueryExactRevisionCacheLimits {
  readonly projections: number;
  readonly totals: number;
}

const rememberLru = <Value>(cache: Map<string, Value>, identity: string, value: Value, limit: number): void => {
  if (cache.has(identity)) {
    cache.delete(identity);
  }
  cache.set(identity, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
};

export const createSessionQueryExactRevisionCache = <Totals, Projection>(
  limits: SessionQueryExactRevisionCacheLimits,
): SessionQueryExactRevisionCache<Totals, Projection> => {
  const projections = new Map<string, Projection>();
  const totals = new Map<string, Totals>();

  return {
    projection: (identity) => {
      const projection = projections.get(identity);
      if (projection !== undefined) {
        rememberLru(projections, identity, projection, limits.projections);
      }
      return projection;
    },
    rememberProjection: (identity, projection) => {
      rememberLru(projections, identity, projection, limits.projections);
    },
    rememberTotals: (identity, value) => {
      rememberLru(totals, identity, value, limits.totals);
    },
    reset: () => {
      projections.clear();
      totals.clear();
    },
    totals: (identity) => totals.get(identity),
  };
};
