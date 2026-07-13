import { describe, expect, test } from 'bun:test';
import {
  IMPORT_EXISTING_ROW_LOOKUP_QUERY_BUDGETS,
  importExistingRowLookupQueryCount,
  MAX_BREAKDOWN_REFRESH_BYTES,
  MAX_OVERVIEW_REFRESH_BYTES,
  MAX_REPORT_RUNNER_ARTIFACT_BYTES,
  MAX_SESSION_QUERY_DATABASE_BYTES,
  MAX_SESSION_QUERY_PAGE_SIZE,
  MAX_SESSION_QUERY_RESULT_BYTES,
} from './report-budgets';

describe('frozen report acceptance budgets', () => {
  test('requires exactly 3 and 125 batched existing-row lookups', () => {
    expect(importExistingRowLookupQueryCount(1000)).toBe(3);
    expect(importExistingRowLookupQueryCount(50_000)).toBe(125);
    expect(IMPORT_EXISTING_ROW_LOOKUP_QUERY_BUDGETS).toEqual({ 1000: 3, 50000: 125 });
  });

  test('keeps supported result and artifact ceilings explicit', () => {
    expect(MAX_OVERVIEW_REFRESH_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_BREAKDOWN_REFRESH_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_SESSION_QUERY_PAGE_SIZE).toBe(200);
    expect(MAX_SESSION_QUERY_RESULT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_REPORT_RUNNER_ARTIFACT_BYTES).toBe(128 * 1024 * 1024);
    expect(MAX_SESSION_QUERY_DATABASE_BYTES).toBe(512 * 1024 * 1024);
  });

  test('rejects invalid lookup-count inputs', () => {
    expect(() => importExistingRowLookupQueryCount(-1)).toThrow('non-negative safe integer');
    expect(() => importExistingRowLookupQueryCount(1.5)).toThrow('non-negative safe integer');
  });
});
