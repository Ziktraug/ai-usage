import { describe, expect, test } from 'bun:test';
import { sessionSortFields } from '@ai-usage/report-core/session-query';
import { sessionColumns } from './session-columns';
import {
  columnDiffFromVisibility,
  columnVisibilityForSessionPreset,
  columnVisibilityFromDiff,
  columnVisibilitySearchForVisibility,
  defaultColumnVisibility,
  isSessionColumnVisible,
  type SessionColumnId,
  sessionColumnIds,
  sessionColumnPresetForVisibility,
  sessionColumnPresets,
  sessionColumnSchema,
} from './session-table-schema';

describe('session table schema', () => {
  test('keeps rendered columns aligned with the shared schema', () => {
    expect(sessionColumns.map((column) => column.id)).toEqual(sessionColumnIds);
    expect(sessionColumnIds).toEqual([...sessionSortFields]);
  });

  test('starts with the focused Work columns in identity-first order', () => {
    expect(
      sessionColumnSchema
        .filter((column) => isSessionColumnVisible(defaultColumnVisibility, column.id))
        .map((column) => column.id),
    ).toEqual(['date', 'session', 'harness', 'project', 'model', 'cost', 'duration']);
  });

  test('offers focused Work, Tokens, and Reliability column presets', () => {
    const visibleColumnsByPreset = Object.fromEntries(
      sessionColumnPresets.map((preset) => [
        preset.id,
        sessionColumnSchema
          .filter((column) => isSessionColumnVisible(columnVisibilityForSessionPreset(preset.id), column.id))
          .map((column) => column.id),
      ]),
    );

    expect(visibleColumnsByPreset).toEqual({
      work: ['date', 'session', 'harness', 'project', 'model', 'cost', 'duration'],
      tokens: ['date', 'session', 'tokIn', 'tokOut', 'cache', 'fresh', 'rtkSaved'],
      reliability: ['date', 'session', 'harness', 'machine', 'provider', 'subagent', 'partial', 'ambiguous'],
    });
  });

  test('recognizes presets after their visibility is persisted as a URL diff', () => {
    for (const preset of sessionColumnPresets) {
      const visibility = columnVisibilityForSessionPreset(preset.id);
      const search = columnVisibilitySearchForVisibility(visibility);
      const restoredVisibility = columnVisibilityFromDiff(search.cols, search.colsBase);
      expect(sessionColumnPresetForVisibility(restoredVisibility)).toBe(preset.id);
    }

    expect(sessionColumnPresetForVisibility({ ...defaultColumnVisibility, calls: true })).toBeNull();
  });

  test('keeps non-empty URL diffs compatible with the previous default columns', () => {
    expect(
      sessionColumnSchema
        .filter((column) => isSessionColumnVisible(columnVisibilityFromDiff(['machine']), column.id))
        .map((column) => column.id),
    ).toEqual([
      'date',
      'session',
      'harness',
      'provider',
      'project',
      'model',
      'cache',
      'fresh',
      'rtkSaved',
      'cost',
      'duration',
    ]);
  });

  test('round-trips the exact legacy default without collapsing it to Work', () => {
    const legacyVisibleColumnIds = new Set<SessionColumnId>([
      'date',
      'session',
      'harness',
      'machine',
      'provider',
      'project',
      'model',
      'cache',
      'fresh',
      'rtkSaved',
      'cost',
      'duration',
    ]);
    const legacyVisibility = Object.fromEntries(
      sessionColumnSchema.map((column) => [column.id, legacyVisibleColumnIds.has(column.id)]),
    );
    const search = columnVisibilitySearchForVisibility(legacyVisibility);
    const restoredVisibility = columnVisibilityFromDiff(search.cols, search.colsBase);

    expect(search).toEqual({ cols: [], colsBase: 'legacy' });

    expect(
      sessionColumnSchema
        .filter((column) => isSessionColumnVisible(restoredVisibility, column.id))
        .map((column) => column.id),
    ).toEqual([...legacyVisibleColumnIds]);
  });

  test('round-trips URL column visibility diffs through the schema', () => {
    expect(columnDiffFromVisibility(columnVisibilityFromDiff(['tokIn', 'cost', 'machine']), 'legacy')).toEqual([
      'machine',
      'tokIn',
      'cost',
    ]);
  });
});
