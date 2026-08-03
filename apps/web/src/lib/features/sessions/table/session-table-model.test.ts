import { describe, expect, test } from 'bun:test';
import {
  columnVisibilityForSessionPreset,
  defaultColumnVisibility,
  sessionColumnPresets,
} from '../../../../session-table-schema';
import { sessionTableColumns, visibleSessionTableColumns } from './session-columns';
import { syntheticCampaignRow, syntheticSessionRow, syntheticSessionRows } from './session-table.fixtures';
import { createSessionTableModel, toggleSessionRowExpanded } from './session-table-model';
import {
  isSessionPagePrefetchRequired,
  projectSessionVirtualRows,
  sessionVirtualBudgets,
} from './session-virtualization';

describe('Svelte session table schema adapter', () => {
  test('preserves the exact 25-column contract and Work/Tokens/Reliability presets', () => {
    expect(sessionTableColumns).toHaveLength(25);
    expect(new Set(sessionTableColumns.map((column) => column.id)).size).toBe(25);
    expect(sessionTableColumns[1]?.id).toBe('session');
    expect(sessionTableColumns[1]?.enableHiding).not.toBe(true);
    expect(sessionColumnPresets.map(({ id }) => id)).toEqual(['work', 'tokens', 'reliability']);
    expect(visibleSessionTableColumns(columnVisibilityForSessionPreset('work')).map(({ id }) => id)).toEqual([
      'date',
      'session',
      'harness',
      'project',
      'model',
      'cost',
      'duration',
    ]);
    expect(visibleSessionTableColumns(columnVisibilityForSessionPreset('tokens')).map(({ id }) => id)).toEqual([
      'date',
      'session',
      'tokIn',
      'tokOut',
      'cache',
      'fresh',
      'rtkSaved',
    ]);
    expect(visibleSessionTableColumns(columnVisibilityForSessionPreset('reliability')).map(({ id }) => id)).toEqual([
      'date',
      'session',
      'harness',
      'machine',
      'provider',
      'subagent',
      'partial',
      'ambiguous',
    ]);
  });

  test('projects stable campaign and child identities through Table Core expansion', () => {
    const child = syntheticSessionRow(2);
    const campaign = syntheticCampaignRow(1, [child]);
    const collapsed = createSessionTableModel({
      expanded: {},
      rows: [campaign],
      sorting: [{ desc: true, id: 'date' }],
      visibility: defaultColumnVisibility,
    });
    expect(collapsed.rows.map(({ id }) => id)).toEqual([campaign.rowId]);

    const expanded = createSessionTableModel({
      expanded: toggleSessionRowExpanded({}, campaign.rowId),
      rows: [campaign],
      sorting: [{ desc: true, id: 'date' }],
      visibility: defaultColumnVisibility,
    });
    expect(expanded.rows.map(({ id }) => id)).toEqual([campaign.rowId, child.rowId]);
    expect(expanded.rows[1]?.depth).toBe(1);
  });
});

describe('bounded session virtualization', () => {
  test('keeps the 5,000-row desktop and mobile DOM windows within fixed budgets', () => {
    const rows = syntheticSessionRows(5000);
    for (const mode of ['desktop', 'mobile'] as const) {
      const first = projectSessionVirtualRows({ mode, rows, scrollTop: 0, viewportHeight: 520 });
      const middle = projectSessionVirtualRows({
        mode,
        rows,
        scrollTop: sessionVirtualBudgets[mode].rowHeight * 2500,
        viewportHeight: 520,
      });
      const end = projectSessionVirtualRows({
        mode,
        rows,
        scrollTop: Number.MAX_SAFE_INTEGER,
        viewportHeight: 520,
      });

      expect(first.rows.length).toBeLessThanOrEqual(sessionVirtualBudgets[mode].maxRows);
      expect(middle.rows.length).toBeLessThanOrEqual(sessionVirtualBudgets[mode].maxRows);
      expect(end.rows.length).toBeLessThanOrEqual(sessionVirtualBudgets[mode].maxRows);
      expect(first.rows[0]?.index).toBe(0);
      expect(end.endIndex).toBe(5000);
      expect(first.topHeight).toBe(0);
      expect(end.bottomHeight).toBe(0);
    }
  });

  test('prefetches automatically only near the active top-level window end', () => {
    expect(
      isSessionPagePrefetchRequired({
        endIndex: 88,
        hasMore: true,
        loading: false,
        mode: 'desktop',
        rowCount: 100,
      }),
    ).toBe(true);
    expect(
      isSessionPagePrefetchRequired({
        endIndex: 50,
        hasMore: true,
        loading: false,
        mode: 'desktop',
        rowCount: 100,
      }),
    ).toBe(false);
    expect(
      isSessionPagePrefetchRequired({
        endIndex: 100,
        hasMore: true,
        loading: true,
        mode: 'mobile',
        rowCount: 100,
      }),
    ).toBe(false);
  });
});
