/** Deterministic seed used by the full-audit acceptance fixture. */
export const REPORT_AUDIT_FIXTURE_SEED = 0x8_a1_1d_17;

/** Existing-row keys loaded by one SQLite import lookup. */
export const IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE = 400;

/** Frozen lookup-query acceptance budgets for the supported audit fixture sizes. */
export const IMPORT_EXISTING_ROW_LOOKUP_QUERY_BUDGETS = {
  1000: 3,
  50000: 125,
} as const;

export const importExistingRowLookupQueryCount = (rowCount: number): number => {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('Import row count must be a non-negative safe integer');
  }
  return Math.ceil(rowCount / IMPORT_EXISTING_ROW_LOOKUP_BATCH_SIZE);
};

/** Largest supported private report-runner artifact. */
export const MAX_REPORT_RUNNER_ARTIFACT_BYTES = 128 * 1024 * 1024;

/** Largest immutable SQLite database materialized for focused report queries. */
export const MAX_SESSION_QUERY_DATABASE_BYTES = 512 * 1024 * 1024;

/** Largest served root bootstrap payload. */
export const MAX_SERVED_BOOTSTRAP_BYTES = 512 * 1024;

/** Largest focused Overview refresh result. */
export const MAX_OVERVIEW_REFRESH_BYTES = 2 * 1024 * 1024;

/** Largest complete focused Breakdown refresh result. */
export const MAX_BREAKDOWN_REFRESH_BYTES = 64 * 1024 * 1024;

/** Largest focused Session query result. */
export const MAX_SESSION_QUERY_RESULT_BYTES = 2 * 1024 * 1024;

/** Largest number of rows accepted in one Session page or campaign-child result. */
export const MAX_SESSION_QUERY_PAGE_SIZE = 200;
