import { describe, expect, test } from 'bun:test';
import { sessionColumns } from './session-columns';
import {
  columnDiffFromVisibility,
  columnVisibilityFromDiff,
  sessionColumnIds,
  sessionCsvColumns,
} from './session-table-schema';

describe('session table schema', () => {
  test('keeps rendered columns aligned with the shared schema', () => {
    expect(sessionColumns.map((column) => column.id)).toEqual(sessionColumnIds);
  });

  test('round-trips URL column visibility diffs through the schema', () => {
    expect(columnDiffFromVisibility(columnVisibilityFromDiff(['tokIn', 'cost']))).toEqual(['tokIn', 'cost']);
  });

  test('owns report CSV column order', () => {
    expect(sessionCsvColumns.map((column) => column.header).slice(0, 6)).toEqual([
      'date',
      'end_date',
      'active_date',
      'harness',
      'machine',
      'machine_id',
    ]);
  });
});
