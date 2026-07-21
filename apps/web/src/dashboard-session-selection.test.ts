import { describe, expect, test } from 'bun:test';
import {
  enrichSessionPresentationRow,
  parseSessionQueryRequest,
  type SessionNeighborResult,
  type SessionPageItem,
  sessionNeighborFingerprint,
} from '@ai-usage/report-core/session-query';
import { createRoot, createSignal } from 'solid-js';
import { buildCampaignViews } from './dashboard-model';
import {
  createDashboardSessionSelection,
  type DashboardSessionSelection,
  type DashboardSessionSelectionOptions,
} from './dashboard-session-selection';
import { demoReportPayload } from './report-data';
import type { SessionQueryState } from './session-query-client';
import type { DashboardRow } from './shared';

const requireValue = <Value>(value: Value | undefined, label: string): Value => {
  if (value === undefined) {
    throw new Error(`Missing ${label} fixture`);
  }
  return value;
};

const rows = demoReportPayload.rows.map(enrichSessionPresentationRow);
const campaignRoot = requireValue(rows[0], 'campaign root');
const campaignChild = requireValue(rows[1], 'campaign child');
const firstStandalone = requireValue(rows[2], 'first standalone session');
const secondStandalone = requireValue(rows[3], 'second standalone session');
const campaign = requireValue(buildCampaignViews(rows, rows)[0], 'campaign');

const createOwnedSelection = (options: DashboardSessionSelectionOptions) => {
  let dispose = (): void => undefined;
  let selection: DashboardSessionSelection | undefined;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    selection = createDashboardSessionSelection(options);
  });
  if (!selection) {
    throw new Error('Dashboard session selection was not created');
  }
  return { dispose, selection };
};

const localData = (sortedRows: DashboardRow[] = rows): DashboardSessionSelectionOptions['local'] => ({
  campaigns: () => [campaign],
  groupCampaigns: () => true,
  reportRows: () => rows,
  sortedRows: () => sortedRows,
});

const query = parseSessionQueryRequest({
  campaigns: false,
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], query: '' },
  pageSize: 100,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'date' }],
});

const servedState = (servedRows: DashboardRow[]): SessionQueryState => {
  const items: SessionPageItem[] = servedRows.map((row) => ({ kind: 'session', row }));
  return {
    campaignChildren: new Map(),
    itemCount: items.length,
    items,
    loadingMore: false,
    nextCursor: null,
    query,
    selectedRowId: null,
    sessionCount: items.length,
  };
};

const neighborResult = (input: {
  next: DashboardRow | null;
  previous: DashboardRow | null;
  rowId: string;
}): SessionNeighborResult => ({
  found: true,
  next: input.next,
  previous: input.previous,
  requestFingerprint: sessionNeighborFingerprint({ query, rowId: input.rowId }),
  revision: query.revision,
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const keyboardEvent = (key: string, target: EventTarget | null = null) => {
  let prevented = false;
  return {
    event: {
      key,
      preventDefault: () => {
        prevented = true;
      },
      target,
    },
    prevented: () => prevented,
  };
};

describe('dashboard session selection', () => {
  test('owns local campaign targets and sorted previous/next navigation', () => {
    const { dispose, selection } = createOwnedSelection({
      local: localData([firstStandalone, secondStandalone]),
      onError: () => undefined,
      overviewRevision: () => null,
    });

    try {
      selection.toggleTableRow(campaignRoot);
      expect(selection.selectedRow()).toBe(campaignRoot);
      expect(selection.selectedCampaign()).toBe(campaign);
      expect(selection.analysisTarget()).toMatchObject({
        campaignKey: campaign.campaignKey,
        kind: 'campaign-root',
        reportRowId: campaignRoot.rowId,
      });

      selection.toggleTableRow(campaignRoot);
      expect(selection.selectedRow()).toBeNull();
      expect(selection.analysisTarget()).toBeNull();

      selection.inspectOverview(firstStandalone);
      selection.navigate(1);
      expect(selection.selectedRow()).toBe(secondStandalone);
      expect(selection.analysisTarget()).toMatchObject({
        kind: 'session',
        reportRowId: secondStandalone.rowId,
      });
      expect(selection.analysisRevision()).toBeNull();

      selection.navigate(-1);
      expect(selection.selectedRow()).toBe(firstStandalone);
      expect(selection.drawerRows()).toEqual([firstStandalone, secondStandalone]);
    } finally {
      dispose();
    }
  });

  test('uses exact-revision served neighbors and retains virtualized selections', async () => {
    const selectedIds: (string | null)[] = [];
    const [active] = createSignal(true);
    const [state] = createSignal<SessionQueryState | undefined>(servedState([firstStandalone, secondStandalone]));
    const [visibleRows, setVisibleRows] = createSignal<DashboardRow[]>([firstStandalone]);
    const { dispose, selection } = createOwnedSelection({
      local: localData(),
      onError: () => undefined,
      overviewRevision: () => 'overview-revision',
      served: {
        active,
        coordinator: {
          loadNeighbors: (rowId) =>
            Promise.resolve(
              rowId === firstStandalone.rowId
                ? neighborResult({ next: secondStandalone, previous: null, rowId })
                : neighborResult({ next: null, previous: firstStandalone, rowId }),
            ),
          select: (rowId) => selectedIds.push(rowId),
        },
        rows: visibleRows,
        state,
      },
    });

    try {
      selection.toggleTableRow(firstStandalone);
      await flushPromises();
      expect(selection.analysisRevision()).toBe(query.revision);
      expect(selection.drawerNavigation()).toMatchObject({
        loading: false,
        next: secondStandalone,
        previous: null,
        total: 2,
      });

      setVisibleRows([]);
      expect(selection.selectedRow()).toBe(firstStandalone);
      expect(selection.drawerRows()).toEqual([]);
      expect(selection.selectedCampaign()).toBeNull();

      selection.navigate(1);
      await flushPromises();
      expect(selection.selectedRow()).toBe(secondStandalone);
      expect(selection.analysisTarget()).toMatchObject({
        kind: 'session',
        reportRowId: secondStandalone.rowId,
      });
      expect(selectedIds).toEqual([firstStandalone.rowId, secondStandalone.rowId]);

      selection.close();
      expect(selection.selectedRow()).toBeNull();
      expect(selection.analysisRevision()).toBeNull();
      expect(selection.drawerNavigation()).toMatchObject({ loading: false, next: null, previous: null });
      expect(selectedIds).toEqual([firstStandalone.rowId, secondStandalone.rowId, null]);
    } finally {
      dispose();
    }
  });

  test('prevents stale neighbor completion from replacing the current selection context', async () => {
    const firstRequest = Promise.withResolvers<SessionNeighborResult | undefined>();
    const secondRequest = Promise.withResolvers<SessionNeighborResult | undefined>();
    const loadedRows: string[] = [];
    const [state] = createSignal<SessionQueryState | undefined>(servedState([firstStandalone, secondStandalone]));
    const { dispose, selection } = createOwnedSelection({
      local: localData(),
      onError: () => undefined,
      overviewRevision: () => 'overview-revision',
      served: {
        active: () => true,
        coordinator: {
          loadNeighbors: (rowId) => {
            loadedRows.push(rowId);
            return rowId === firstStandalone.rowId ? firstRequest.promise : secondRequest.promise;
          },
          select: () => undefined,
        },
        rows: () => [firstStandalone, secondStandalone],
        state,
      },
    });

    try {
      selection.selectDrawerSession(firstStandalone);
      selection.selectDrawerSession(secondStandalone);
      expect(loadedRows).toEqual([firstStandalone.rowId, secondStandalone.rowId]);

      firstRequest.resolve(neighborResult({ next: campaignChild, previous: null, rowId: firstStandalone.rowId }));
      await flushPromises();
      expect(selection.drawerNavigation()).toMatchObject({ loading: true, next: null, previous: null });

      secondRequest.resolve(neighborResult({ next: null, previous: firstStandalone, rowId: secondStandalone.rowId }));
      await flushPromises();
      expect(selection.drawerNavigation()).toMatchObject({
        loading: false,
        next: null,
        previous: firstStandalone,
      });
    } finally {
      dispose();
    }
  });

  test('loads neighbors once for each reactive selection', async () => {
    const loadedRows: string[] = [];
    const [state] = createSignal<SessionQueryState | undefined>(servedState([firstStandalone, secondStandalone]));
    const { dispose, selection } = createOwnedSelection({
      local: localData(),
      onError: () => undefined,
      overviewRevision: () => 'overview-revision',
      served: {
        active: () => true,
        coordinator: {
          loadNeighbors: (rowId) => {
            loadedRows.push(rowId);
            return Promise.resolve(neighborResult({ next: null, previous: null, rowId }));
          },
          select: () => undefined,
        },
        rows: () => [firstStandalone, secondStandalone],
        state,
      },
    });

    try {
      selection.selectDrawerSession(firstStandalone);
      await flushPromises();
      selection.selectDrawerSession(secondStandalone);
      await flushPromises();

      expect(loadedRows).toEqual([firstStandalone.rowId, secondStandalone.rowId]);
    } finally {
      dispose();
    }
  });

  test('stops loading served neighbors when Sessions becomes inactive', async () => {
    const loadedRows: string[] = [];
    const [active, setActive] = createSignal(true);
    const [state] = createSignal<SessionQueryState | undefined>(servedState([firstStandalone, secondStandalone]));
    const { dispose, selection } = createOwnedSelection({
      local: localData(),
      onError: () => undefined,
      overviewRevision: () => 'overview-revision',
      served: {
        active,
        coordinator: {
          loadNeighbors: (rowId) => {
            loadedRows.push(rowId);
            return Promise.resolve(neighborResult({ next: secondStandalone, previous: null, rowId }));
          },
          select: () => undefined,
        },
        rows: () => [firstStandalone, secondStandalone],
        state,
      },
    });

    try {
      selection.selectDrawerSession(firstStandalone);
      await flushPromises();
      await flushPromises();
      expect(loadedRows).toEqual([firstStandalone.rowId]);

      setActive(false);
      selection.inspectOverview(secondStandalone);
      await flushPromises();

      expect(loadedRows).toEqual([firstStandalone.rowId]);
      expect(selection.drawerNavigation()).toBeUndefined();
    } finally {
      dispose();
    }
  });

  test('maps drawer keyboard commands while ignoring editable targets', () => {
    const { dispose, selection } = createOwnedSelection({
      local: localData([campaignRoot, firstStandalone, secondStandalone]),
      onError: () => undefined,
      overviewRevision: () => null,
    });
    const inputTarget = Object.assign(new EventTarget(), { isContentEditable: false, tagName: 'INPUT' });
    const editableTarget = Object.assign(new EventTarget(), { isContentEditable: true, tagName: 'DIV' });

    try {
      selection.inspectOverview(firstStandalone);

      const ignoredInputCommand = keyboardEvent('j', inputTarget);
      selection.handleKeyDown(ignoredInputCommand.event);
      expect(selection.selectedRow()).toBe(firstStandalone);
      expect(ignoredInputCommand.prevented()).toBe(false);

      const downCommand = keyboardEvent('ArrowDown');
      selection.handleKeyDown(downCommand.event);
      expect(selection.selectedRow()).toBe(secondStandalone);
      expect(downCommand.prevented()).toBe(true);

      const upCommand = keyboardEvent('k');
      selection.handleKeyDown(upCommand.event);
      expect(selection.selectedRow()).toBe(firstStandalone);
      expect(upCommand.prevented()).toBe(true);

      const ignoredEditableCommand = keyboardEvent('ArrowUp', editableTarget);
      selection.handleKeyDown(ignoredEditableCommand.event);
      expect(selection.selectedRow()).toBe(firstStandalone);
      expect(ignoredEditableCommand.prevented()).toBe(false);

      const closeCommand = keyboardEvent('Escape');
      selection.handleKeyDown(closeCommand.event);
      expect(selection.selectedRow()).toBeNull();
      expect(closeCommand.prevented()).toBe(false);
    } finally {
      dispose();
    }
  });
});
