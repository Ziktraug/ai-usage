import { type SessionNeighborResult, sessionNeighborFingerprint } from '@ai-usage/report-core/session-query';
import { type Accessor, batch, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { CampaignView } from './dashboard-model';
import {
  type SessionAnalysisTarget,
  sessionAnalysisTargetForSession,
  sessionAnalysisTargetForTopLevelRow,
} from './session-analysis-target';
import { createSessionNeighborRequestController } from './session-neighbor-request-controller';
import type { SessionQueryCoordinator, SessionQueryState } from './session-query-client';
import { type DashboardRow, rowKey } from './shared';

const FORM_CONTROL_TAG_PATTERN = /^(INPUT|SELECT|TEXTAREA)$/;

export type DashboardSessionSelectionCoordinator = Pick<SessionQueryCoordinator, 'loadNeighbors' | 'select'>;

export interface DashboardSessionSelectionLocalData {
  campaigns: Accessor<CampaignView[]>;
  groupCampaigns: Accessor<boolean>;
  reportRows: Accessor<DashboardRow[]>;
  sortedRows: Accessor<DashboardRow[]>;
}

export interface DashboardSessionSelectionServedData {
  active: Accessor<boolean>;
  coordinator: DashboardSessionSelectionCoordinator;
  rows: Accessor<DashboardRow[]>;
  state: Accessor<SessionQueryState | undefined>;
}

export interface DashboardSessionSelectionOptions {
  local: DashboardSessionSelectionLocalData;
  onError: (message: string) => void;
  overviewRevision: Accessor<string | null>;
  served?: DashboardSessionSelectionServedData;
}

export interface DashboardSessionDrawerNavigation {
  loading: boolean;
  next: DashboardRow | null;
  previous: DashboardRow | null;
  total: number;
}

export interface DashboardSessionSelection {
  analysisRevision: Accessor<string | null>;
  analysisTarget: Accessor<SessionAnalysisTarget | null>;
  close: () => void;
  drawerNavigation: Accessor<DashboardSessionDrawerNavigation | undefined>;
  drawerRows: Accessor<DashboardRow[]>;
  handleKeyDown: (event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'target'>) => void;
  inspectOverview: (row: DashboardRow) => void;
  navigate: (delta: number) => void;
  selectDrawerSession: (row: DashboardRow) => void;
  selectedCampaign: Accessor<CampaignView | null>;
  selectedKey: Accessor<string | null>;
  selectedRow: Accessor<DashboardRow | null>;
  toggleTableRow: (row: DashboardRow) => void;
}

interface SessionSelectionValue {
  key: string | null;
  navigationRow: DashboardRow | null;
  revision: string | null;
  target: SessionAnalysisTarget | null;
}

const isEditableKeyboardTarget = (target: EventTarget | null): boolean => {
  if (!target) {
    return false;
  }
  const tagName: unknown = Reflect.get(target, 'tagName');
  const isContentEditable: unknown = Reflect.get(target, 'isContentEditable');
  return (typeof tagName === 'string' && FORM_CONTROL_TAG_PATTERN.test(tagName)) || isContentEditable === true;
};

export const createDashboardSessionSelection = (
  options: DashboardSessionSelectionOptions,
): DashboardSessionSelection => {
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [selectedNavigationRow, setSelectedNavigationRow] = createSignal<DashboardRow | null>(null);
  const [analysisTarget, setAnalysisTarget] = createSignal<SessionAnalysisTarget | null>(null);
  const [analysisRevision, setAnalysisRevision] = createSignal<string | null>(null);
  const [neighbors, setNeighbors] = createSignal<SessionNeighborResult>();
  const [neighborsLoading, setNeighborsLoading] = createSignal(false);

  const selectedRow = (): DashboardRow | null => {
    const key = selectedKey();
    if (!key) {
      return null;
    }
    const target = analysisTarget();
    if (target?.summaryRow.rowId === key) {
      return target.summaryRow;
    }
    if (!options.served) {
      return options.local.reportRows().find((row) => rowKey(row) === key) ?? null;
    }
    const servedRow = options.served
      .rows()
      .flatMap((row) => [row, ...(row.children ?? [])])
      .find((row) => rowKey(row) === key);
    const navigationRow = selectedNavigationRow();
    return (
      servedRow ??
      (navigationRow?.rowId === key ? navigationRow : null) ??
      options.local.reportRows().find((row) => rowKey(row) === key) ??
      null
    );
  };

  const selectedCampaign = (): CampaignView | null => {
    if (options.served?.active() && options.served.state()) {
      return null;
    }
    const row = selectedRow();
    if (!row) {
      return null;
    }
    const key = rowKey(row);
    return (
      options.local
        .campaigns()
        .find((campaign) => campaign.allRows.some((campaignRow) => rowKey(campaignRow) === key)) ?? null
    );
  };

  const neighborRequests = options.served
    ? createSessionNeighborRequestController({
        loadNeighbors: (rowId) => options.served?.coordinator.loadNeighbors(rowId) ?? Promise.resolve(undefined),
        onError: (error) => {
          options.onError(error instanceof Error ? error.message : 'Failed to load session neighbors');
        },
        onLoadingChange: setNeighborsLoading,
        onNeighbors: setNeighbors,
      })
    : undefined;

  const synchronizeNeighbors = async (): Promise<void> => {
    const active = options.served?.active() ?? false;
    const row = selectedRow();
    const state = options.served?.state();
    if (!(active && options.served && neighborRequests && state && row)) {
      neighborRequests?.close();
      setNeighbors();
      setNeighborsLoading(false);
      return;
    }
    try {
      await neighborRequests.load({
        requestKey: sessionNeighborFingerprint({ query: state.query, rowId: row.rowId }),
        rowId: row.rowId,
      });
    } catch (error) {
      options.onError(error instanceof Error ? error.message : 'Failed to coordinate session neighbors');
    }
  };

  const setSelection = (selection: SessionSelectionValue): void => {
    batch(() => {
      setSelectedNavigationRow(selection.navigationRow);
      setAnalysisTarget(selection.target);
      setAnalysisRevision(selection.revision);
      setSelectedKey(selection.key);
      options.served?.coordinator.select(selection.key);
    });
    synchronizeNeighbors();
  };

  const close = (): void => {
    setSelection({ key: null, navigationRow: null, revision: null, target: null });
  };

  const navigate = (delta: number): void => {
    const servedState = options.served?.state();
    if (options.served?.active() && servedState) {
      const next = delta > 0 ? neighbors()?.next : neighbors()?.previous;
      if (next) {
        setSelection({
          key: rowKey(next),
          navigationRow: next,
          revision: servedState.query.revision,
          target: sessionAnalysisTargetForSession(next),
        });
      }
      return;
    }
    const rows = options.local.sortedRows();
    const index = rows.findIndex((row) => rowKey(row) === selectedKey());
    if (index === -1) {
      return;
    }
    const next = rows[index + delta];
    if (next) {
      setSelection({
        key: rowKey(next),
        navigationRow: next,
        revision: null,
        target: sessionAnalysisTargetForSession(next),
      });
    }
  };

  onCleanup(() => neighborRequests?.close());
  createEffect(() => {
    options.served?.active();
    options.served?.state();
    untrack(synchronizeNeighbors);
  });

  const toggleTableRow = (row: DashboardRow): void => {
    const next = selectedKey() === rowKey(row) ? null : rowKey(row);
    const servedActive = options.served?.active() ?? false;
    const target = next
      ? sessionAnalysisTargetForTopLevelRow({
          campaigns: servedActive || !options.local.groupCampaigns() ? [] : options.local.campaigns(),
          pageItems: servedActive ? (options.served?.state()?.items ?? []) : [],
          row,
        })
      : null;
    setSelection({
      key: next,
      navigationRow: next ? row : null,
      revision: next ? (options.served?.state()?.query.revision ?? null) : null,
      target,
    });
  };

  const inspectOverview = (row: DashboardRow): void => {
    setSelection({
      key: rowKey(row),
      navigationRow: row,
      revision: options.overviewRevision(),
      target: sessionAnalysisTargetForSession(row),
    });
  };

  const selectDrawerSession = (row: DashboardRow): void => {
    setSelection({
      key: rowKey(row),
      navigationRow: row,
      revision: options.served?.state()?.query.revision ?? null,
      target: sessionAnalysisTargetForSession(row),
    });
  };

  const handleKeyDown = (event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'target'>): void => {
    if (!selectedRow() || isEditableKeyboardTarget(event.target)) {
      return;
    }
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      navigate(1);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      navigate(-1);
    }
  };

  const drawerNavigation = (): DashboardSessionDrawerNavigation | undefined => {
    const state = options.served?.state();
    if (!(options.served?.active() && state)) {
      return;
    }
    return {
      loading: neighborsLoading(),
      next: neighbors()?.next ?? null,
      previous: neighbors()?.previous ?? null,
      total: state.sessionCount,
    };
  };

  const drawerRows = (): DashboardRow[] =>
    options.served?.active() ? options.served.rows() : options.local.sortedRows();

  return {
    analysisRevision,
    analysisTarget,
    close,
    drawerNavigation,
    drawerRows,
    handleKeyDown,
    inspectOverview,
    navigate,
    selectDrawerSession,
    selectedCampaign,
    selectedKey,
    selectedRow,
    toggleTableRow,
  };
};
