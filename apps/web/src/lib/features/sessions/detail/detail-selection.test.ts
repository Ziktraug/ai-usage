import { describe, expect, test } from 'bun:test';
import type { SessionPageItem, SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { type DetailSelectionWindow, resolveDetailSelection, routeForRow, routeForSelection } from './detail-selection';

const query: SessionQueryRequest = {
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 100,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'date' }],
};

const row = (rowId: string, overrides: Partial<SessionPresentationRow> = {}): SessionPresentationRow =>
  ({ rowId, sessionLabel: rowId, ...overrides }) as SessionPresentationRow;

const campaignItem = (campaignKey: string, rowId: string): SessionPageItem => ({
  campaignKey,
  kind: 'campaign',
  row: row(rowId, { campaignKey, campaignTotalCount: 3, campaignVisibleCount: 3 }),
});

const window = (overrides: Partial<DetailSelectionWindow> = {}): DetailSelectionWindow => ({
  campaignChildren: new Map(),
  campaignSessions: new Map(),
  items: [campaignItem('campaign-a', 'root-a')],
  query,
  sessionCount: 42,
  ...overrides,
});

describe('detail selection from the route', () => {
  test('closes without a route and opens a campaign from the loaded window', () => {
    expect(
      resolveDetailSelection({
        campaignLookup: undefined,
        contextRows: [],
        lookupRow: undefined,
        revision: 'revision-a',
        route: null,
        window: window(),
      }),
    ).toEqual({ kind: 'closed' });
    const state = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { campaignKey: 'campaign-a', kind: 'campaign' },
      window: window(),
    });
    expect(state.kind).toBe('open');
    if (state.kind !== 'open') {
      throw new Error('expected an open campaign');
    }
    expect(state.selection.query).toBe(query);
    expect(state.selection.total).toBe(42);
    expect(state.selection.target).toMatchObject({ campaignKey: 'campaign-a', kind: 'campaign-root', totalCount: 3 });
    expect(routeForSelection(state.selection)).toEqual({ campaignKey: 'campaign-a', kind: 'campaign' });
  });

  test('opens a campaign member with the campaign-scoped query and its member count', () => {
    const member = row('child-1', { campaignKey: 'campaign-a' });
    const state = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'child-1' },
      window: window({
        campaignSessions: new Map([['campaign-a', { items: [member], root: row('root-a'), sessionCount: 7 }]]),
      }),
    });
    if (state.kind !== 'open') {
      throw new Error('expected an open member');
    }
    expect(state.selection.row).toBe(member);
    expect(state.selection.total).toBe(7);
    expect(state.selection.query?.filters.fields.campaign).toBe('campaign-a');
    expect(state.selection.target).toEqual({ kind: 'session', reportRowId: 'child-1', summaryRow: member });
    expect(routeForSelection(state.selection)).toEqual({ kind: 'session', rowId: 'child-1' });
    // A neighbor row that is a campaign root in the loaded window opens the campaign.
    expect(routeForSelection({ row: row('root-a') }, window())).toEqual({
      campaignKey: 'campaign-a',
      kind: 'campaign',
    });
    expect(routeForSelection({ row: row('root-a') })).toEqual({ kind: 'session', rowId: 'root-a' });
    expect(routeForRow(campaignItem('campaign-a', 'root-a').row)).toEqual({
      campaignKey: 'campaign-a',
      kind: 'campaign',
    });
    expect(routeForRow(row('child-1', { campaignKey: 'campaign-a', campaignTotalCount: 1 }))).toEqual({
      kind: 'session',
      rowId: 'child-1',
    });
    expect(routeForRow(row('solo'))).toEqual({ kind: 'session', rowId: 'solo' });
  });

  test('never shows a campaign aggregate under a session URL', () => {
    const state = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'root-a' },
      window: window(),
    });
    expect(state).toEqual({ kind: 'loading', lookup: 'session' });
    const withRoot = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'root-a' },
      window: window({
        campaignSessions: new Map([['campaign-a', { items: [], root: row('root-a'), sessionCount: 3 }]]),
      }),
    });
    expect(withRoot).toMatchObject({ kind: 'open', selection: { row: { rowId: 'root-a' }, total: 3 } });
    const single = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'solo' },
      window: window({
        items: [
          {
            campaignKey: 'campaign-solo',
            kind: 'campaign',
            row: row('solo', { campaignKey: 'campaign-solo', campaignTotalCount: 1, campaignVisibleCount: 1 }),
          },
        ],
      }),
    });
    expect(single).toMatchObject({ kind: 'open', selection: { row: { rowId: 'solo' }, total: 42 } });
    const aggregateInContext = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [campaignItem('campaign-a', 'root-a').row],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'root-a' },
      window: undefined,
    });
    expect(aggregateInContext).toEqual({ kind: 'loading', lookup: 'session' });
  });

  test('falls back to context rows, then asks for a lookup, then reports a missing row', () => {
    const contextRow = row('top-3');
    const fromContext = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [contextRow],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'top-3' },
      window: undefined,
    });
    expect(fromContext).toMatchObject({ kind: 'open', selection: { revision: 'revision-a', row: contextRow } });
    expect(fromContext.kind === 'open' && fromContext.selection.query).toBeUndefined();

    const loading = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'elsewhere' },
      window: window(),
    });
    expect(loading).toEqual({ kind: 'loading', lookup: 'session' });

    const missing = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: null,
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'elsewhere' },
      window: window(),
    });
    expect(missing).toEqual({ kind: 'missing', route: { kind: 'session', rowId: 'elsewhere' } });

    const found = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: row('elsewhere'),
      revision: 'revision-a',
      route: { kind: 'session', rowId: 'elsewhere' },
      window: window(),
    });
    expect(found).toMatchObject({ kind: 'open', selection: { revision: 'revision-a', row: { rowId: 'elsewhere' } } });
  });

  test('resolves a campaign the window does not hold through the campaign lookup', () => {
    const loading = resolveDetailSelection({
      campaignLookup: undefined,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { campaignKey: 'campaign-z', kind: 'campaign' },
      window: window(),
    });
    expect(loading).toEqual({ kind: 'loading', lookup: 'campaign' });
    const found = resolveDetailSelection({
      campaignLookup: campaignItem('campaign-z', 'root-z'),
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { campaignKey: 'campaign-z', kind: 'campaign' },
      window: window(),
    });
    expect(found).toMatchObject({ kind: 'open', selection: { query, row: { rowId: 'root-z' }, total: 42 } });
    const missing = resolveDetailSelection({
      campaignLookup: null,
      contextRows: [],
      lookupRow: undefined,
      revision: 'revision-a',
      route: { campaignKey: 'campaign-z', kind: 'campaign' },
      window: window(),
    });
    expect(missing).toEqual({ kind: 'missing', route: { campaignKey: 'campaign-z', kind: 'campaign' } });
  });
});
