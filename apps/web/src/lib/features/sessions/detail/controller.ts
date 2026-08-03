import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { SessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import { classifySessionAnalysisError, type SessionAnalysisError } from '../../../../session-analysis-error';
import { type SessionAnalysisTarget, sessionAnalysisTargetForSession } from '../../../../session-analysis-target';
import { createDrawerIdentityOwner, drawerCommandForKey } from '../../../foundation/navigation/svelte/navigation';
import type { SessionDetailQueryOwner } from './query-owner';

const EDITABLE_TAG = /^(INPUT|SELECT|TEXTAREA)$/;

export interface SessionDetailNavigation {
  readonly loading: boolean;
  readonly next: SessionPresentationRow | null;
  readonly previous: SessionPresentationRow | null;
  readonly total: number;
}

export interface SessionDetailControllerSnapshot {
  readonly analysisError: SessionAnalysisError | null;
  readonly analysisLoading: boolean;
  readonly analysisOpen: boolean;
  readonly analysisResponse: SessionDetailResponse | null;
  readonly navigation: SessionDetailNavigation | undefined;
  readonly revision: string | null;
  readonly row: SessionPresentationRow | null;
  readonly target: SessionAnalysisTarget | null;
  readonly vcsResolution: SessionVcsResolveResponse | null;
  readonly vcsResolving: boolean;
}

export interface SessionSelectionInput {
  readonly query?: SessionQueryRequest;
  readonly row: SessionPresentationRow;
  readonly target?: SessionAnalysisTarget;
  readonly total?: number;
}

export interface SessionDetailController {
  readonly close: () => void;
  readonly current: () => SessionDetailControllerSnapshot;
  readonly dispose: () => void;
  readonly handleKeyDown: (event: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'target'>) => void;
  readonly navigate: (delta: -1 | 1) => void;
  readonly resolveVcs: () => Promise<void>;
  readonly retryAnalysis: () => Promise<void>;
  readonly select: (selection: SessionSelectionInput) => void;
  readonly subscribe: (listener: (snapshot: SessionDetailControllerSnapshot) => void) => () => void;
  readonly toggleAnalysis: () => Promise<void>;
}

const initialSnapshot = (): SessionDetailControllerSnapshot => ({
  analysisError: null,
  analysisLoading: false,
  analysisOpen: false,
  analysisResponse: null,
  navigation: undefined,
  revision: null,
  row: null,
  target: null,
  vcsResolution: null,
  vcsResolving: false,
});

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!target) {
    return false;
  }
  const tagName: unknown = Reflect.get(target, 'tagName');
  const editable: unknown = Reflect.get(target, 'isContentEditable');
  return (typeof tagName === 'string' && EDITABLE_TAG.test(tagName)) || editable === true;
};

export const createSessionDetailController = (options: {
  readonly onSelectedRowId?: (rowId: string | null) => void;
  readonly query: SessionDetailQueryOwner;
  readonly rows: () => readonly SessionPresentationRow[];
}): SessionDetailController => {
  const identity = createDrawerIdentityOwner();
  const listeners = new Set<(snapshot: SessionDetailControllerSnapshot) => void>();
  let disposed = false;
  let analysisGeneration = 0;
  let selectedQuery: SessionQueryRequest | undefined;
  let selectionGeneration = 0;
  let snapshot = initialSnapshot();
  let vcsGeneration = 0;

  const publish = (patch: Partial<SessionDetailControllerSnapshot>): void => {
    if (disposed) {
      return;
    }
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const resetDependentState = (): void => {
    selectionGeneration += 1;
    analysisGeneration += 1;
    vcsGeneration += 1;
    options.query.resetDetail();
    options.query.resetVcs();
    publish({
      analysisError: null,
      analysisLoading: false,
      analysisOpen: false,
      analysisResponse: null,
      vcsResolution: null,
      vcsResolving: false,
    });
  };

  const loadNeighbors = async (requestGeneration: number): Promise<void> => {
    const query = selectedQuery;
    const row = snapshot.row;
    if (!(query && row)) {
      return;
    }
    publish({
      navigation: {
        loading: true,
        next: snapshot.navigation?.next ?? null,
        previous: snapshot.navigation?.previous ?? null,
        total: snapshot.navigation?.total ?? options.rows().length,
      },
    });
    try {
      const neighbors = await options.query.loadNeighbors({ query, rowId: row.rowId });
      if (neighbors && requestGeneration === selectionGeneration && snapshot.row?.rowId === row.rowId) {
        publish({
          navigation: {
            loading: false,
            next: neighbors.next,
            previous: neighbors.previous,
            total: snapshot.navigation?.total ?? options.rows().length,
          },
        });
      }
    } catch {
      if (requestGeneration === selectionGeneration) {
        publish({
          navigation: {
            loading: false,
            next: null,
            previous: null,
            total: snapshot.navigation?.total ?? options.rows().length,
          },
        });
      }
    }
  };

  const select = (selection: SessionSelectionInput): void => {
    resetDependentState();
    selectedQuery = selection.query;
    const revision = selection.query?.revision ?? null;
    const target = selection.target ?? sessionAnalysisTargetForSession(selection.row);
    if (revision) {
      identity.select({
        campaignKey: selection.row.campaignKey ?? selection.row.rowId,
        kind: 'served',
        revision,
        rowKey: selection.row.rowId,
      });
    } else {
      identity.select({ kind: 'local', rowKey: selection.row.rowId });
    }
    publish({
      navigation: selection.query
        ? {
            loading: true,
            next: null,
            previous: null,
            total: selection.total ?? options.rows().length,
          }
        : undefined,
      revision,
      row: selection.row,
      target,
    });
    options.onSelectedRowId?.(selection.row.rowId);
    const requestGeneration = selectionGeneration;
    if (selection.query) {
      loadNeighbors(requestGeneration).catch(() => undefined);
    }
  };

  const close = (): void => {
    resetDependentState();
    identity.clear();
    selectedQuery = undefined;
    publish({ navigation: undefined, revision: null, row: null, target: null });
    options.onSelectedRowId?.(null);
  };

  const navigate = (delta: -1 | 1): void => {
    const neighbor = delta > 0 ? snapshot.navigation?.next : snapshot.navigation?.previous;
    if (selectedQuery) {
      if (neighbor) {
        select({
          query: selectedQuery,
          row: neighbor,
          ...(snapshot.navigation === undefined ? {} : { total: snapshot.navigation.total }),
        });
      }
      return;
    }
    const rows = options.rows();
    const index = rows.findIndex((row) => row.rowId === snapshot.row?.rowId);
    const next = rows[index + delta];
    if (next) {
      select({ row: next });
    }
  };

  const loadAnalysis = async (): Promise<void> => {
    const { revision, target } = snapshot;
    if (!(revision && target)) {
      return;
    }
    const requestGeneration = ++analysisGeneration;
    publish({ analysisError: null, analysisLoading: true, analysisResponse: null });
    try {
      const response = await options.query.loadDetail({
        revision,
        rowId: target.reportRowId,
      });
      if (response && requestGeneration === analysisGeneration) {
        publish({ analysisLoading: false, analysisResponse: response });
      }
    } catch (error) {
      if (requestGeneration === analysisGeneration) {
        publish({
          analysisError: classifySessionAnalysisError(error),
          analysisLoading: false,
        });
      }
    }
  };

  const toggleAnalysis = async (): Promise<void> => {
    if (snapshot.analysisOpen) {
      analysisGeneration += 1;
      options.query.resetDetail();
      publish({
        analysisError: null,
        analysisLoading: false,
        analysisOpen: false,
        analysisResponse: null,
      });
      return;
    }
    publish({ analysisOpen: true });
    await loadAnalysis();
  };

  const resolveVcs = async (): Promise<void> => {
    const { revision, target } = snapshot;
    if (!(revision && target)) {
      return;
    }
    const requestGeneration = ++vcsGeneration;
    publish({ vcsResolution: null, vcsResolving: true });
    try {
      const resolution = await options.query.loadVcs({
        revision,
        rowId: target.reportRowId,
      });
      if (resolution && requestGeneration === vcsGeneration) {
        publish({ vcsResolution: resolution, vcsResolving: false });
      }
    } catch {
      if (requestGeneration === vcsGeneration) {
        publish({
          vcsResolution: { reason: 'resolver-unavailable', status: 'unavailable' },
          vcsResolving: false,
        });
      }
    }
  };

  return {
    close,
    current: () => snapshot,
    dispose: () => {
      if (disposed) {
        return;
      }
      close();
      disposed = true;
      listeners.clear();
      options.query.close();
    },
    handleKeyDown: (event) => {
      if (!(snapshot.row && !isEditableTarget(event.target))) {
        return;
      }
      const command = drawerCommandForKey(event.key);
      if (command === 'close') {
        close();
      } else if (command === 'next') {
        event.preventDefault();
        navigate(1);
      } else if (command === 'previous') {
        event.preventDefault();
        navigate(-1);
      }
    },
    navigate,
    resolveVcs,
    retryAnalysis: loadAnalysis,
    select,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    toggleAnalysis,
  };
};
