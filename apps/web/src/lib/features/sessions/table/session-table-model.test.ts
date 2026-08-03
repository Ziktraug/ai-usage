import { describe, expect, test } from 'bun:test';
import {
  columnVisibilityForSessionPreset,
  defaultColumnVisibility,
  sessionColumnPresets,
} from '../../../../session-table-schema';
import { applySessionFieldFilter, projectSessionCell, sessionSortDescendingByDefault } from './session-cell-projection';
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

  test('projects interactive filters, highlighted titles, provenance, and campaign semantics for Svelte cells', () => {
    const row = {
      ...syntheticSessionRow(7),
      campaignClassifierCount: 2,
      campaignClassifierFreshTokens: 4321,
      campaignKey: 'campaign-seven',
      campaignTotalCount: 4,
      campaignVisibleCount: 3,
      costApprox: 1.25,
      costKnown: false,
      origin: 'classifier' as const,
      partial: true,
      titleSource: 'first-prompt' as const,
    };

    expect(projectSessionCell(row, 'harness', 'session')).toMatchObject({
      kind: 'harness-filter',
      label: row.harness,
      title: `Filter by ${row.harness}`,
    });
    expect(projectSessionCell(row, 'provider', 'session')).toMatchObject({
      field: 'provider',
      kind: 'field-filter',
      label: row.providerDisplay,
      value: row.providerDisplay,
    });
    expect(projectSessionCell(row, 'project', 'session')).toMatchObject({
      field: 'project',
      kind: 'field-filter',
      value: row.projectKey,
    });
    expect(projectSessionCell(row, 'model', 'session')).toMatchObject({
      field: 'model',
      kind: 'field-filter',
      value: row.modelKey,
    });
    expect(projectSessionCell(row, 'session', 'session')).toMatchObject({
      campaignLabel: 'Campaign · 3 sessions',
      classifierLabel: '+ 2 automated reviews · 4,321 fresh',
      kind: 'session',
      originLabel: 'Automated review',
    });
    expect(projectSessionCell(row, 'session', 'session')).toHaveProperty('segments.1.match', true);
    expect(projectSessionCell(row, 'session', 'session')).toHaveProperty('provenanceTitle');
    expect(projectSessionCell(row, 'cost', '')).toMatchObject({
      kind: 'value',
      label: '≥ $1.25',
      title: 'Known API-value subtotal; one or more model prices are unavailable',
    });
  });

  test('starts text sorts ascending while dates, metrics, and flags start descending', () => {
    for (const id of ['session', 'harness', 'machine', 'provider', 'project', 'model'] as const) {
      expect(sessionSortDescendingByDefault(id), id).toBe(false);
    }
    for (const id of ['date', 'tokIn', 'cost', 'duration', 'partial'] as const) {
      expect(sessionSortDescendingByDefault(id), id).toBe(true);
    }
  });

  test('stops row activation before applying an exact field filter', () => {
    const calls: string[] = [];
    applySessionFieldFilter(
      { stopPropagation: () => calls.push('stop') },
      (field, value) => calls.push(`${field}:${value}`),
      'project',
      'project-seven',
    );
    expect(calls).toEqual(['stop', 'project:project-seven']);
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
