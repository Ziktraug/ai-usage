import { describe, expect, test } from 'bun:test';
import { createRoot, createSignal } from 'solid-js';
import {
  createDashboardReportLifecycle,
  type DashboardReportDestinationScope,
  type DashboardReportLifecycle,
  transitionDashboardPublication,
} from './dashboard-report-lifecycle';
import type { DashboardServedDestination } from './dashboard-served-report-session';
import type { ServedReportRefreshOutcome, ServedReportSession } from './served-report-session';

type RefreshOutcome = ServedReportRefreshOutcome;

interface DeferredRefresh {
  promise: Promise<RefreshOutcome>;
  resolve: (outcome: RefreshOutcome) => void;
}

const createDeferredRefresh = (): DeferredRefresh => {
  let resolveRefresh: ((outcome: RefreshOutcome) => void) | undefined;
  const promise = new Promise<RefreshOutcome>((resolve) => {
    resolveRefresh = resolve;
  });
  if (!resolveRefresh) {
    throw new Error('Deferred refresh resolver was not initialized');
  }
  return { promise, resolve: resolveRefresh };
};

const committedOutcome = (): RefreshOutcome => ({
  descriptor: { captureFingerprint: 'capture-a', revision: 'revision-a' },
  status: 'committed',
});

const overviewScope = (query = ''): DashboardReportDestinationScope => ({
  kind: 'overview',
  query: {
    filters: { fields: {}, harness: [], machine: [], query },
    range: { from: null, to: null },
  },
});

const sessionsScope = (): DashboardReportDestinationScope => ({
  kind: 'sessions',
  query: overviewScope().query,
  sessions: {
    filters: { fields: {}, harness: [], machine: [], query: '' },
    pageSize: 100,
    range: { from: null, to: null },
    sort: [{ desc: true, id: 'date' }],
  },
});

interface LifecycleHarness {
  abortCount: () => number;
  calls: DashboardServedDestination[];
  closeCount: () => number;
  dispose: () => void;
  errors: string[];
  lifecycle: DashboardReportLifecycle;
  setDestinationScope: (scope: DashboardReportDestinationScope | undefined) => void;
  setReady: (ready: boolean) => void;
}

const createLifecycleHarness = (
  refresh: (destination: DashboardServedDestination) => Promise<RefreshOutcome>,
): LifecycleHarness => {
  const calls: DashboardServedDestination[] = [];
  const errors: string[] = [];
  let abortCount = 0;
  let closeCount = 0;
  const servedReportSession: ServedReportSession<DashboardServedDestination> = {
    abort: () => {
      abortCount += 1;
    },
    refresh: async (destination) => {
      calls.push(destination);
      return await refresh(destination);
    },
  };

  return createRoot((dispose) => {
    const [currentRevision] = createSignal('revision-a');
    const [destinationScope, setDestinationScope] = createSignal<DashboardReportDestinationScope | undefined>(
      overviewScope(),
    );
    const [publicationRevision] = createSignal<string | undefined>();
    const [ready, setReady] = createSignal(false);
    const lifecycle = createDashboardReportLifecycle({
      currentOverviewRequestFingerprint: () => undefined,
      currentRevision,
      destinationScope,
      onError: (message) => errors.push(message),
      publicationRevision,
      ready,
      servedReportSession,
      sessionCoordinator: {
        close: () => {
          closeCount += 1;
        },
      },
      sessionState: () => undefined,
    });

    return {
      abortCount: () => abortCount,
      calls,
      closeCount: () => closeCount,
      dispose,
      errors,
      lifecycle,
      setDestinationScope,
      setReady,
    };
  });
};

describe('dashboard report lifecycle', () => {
  test('waits for client readiness and exposes a restart for the current destination', async () => {
    const harness = createLifecycleHarness(() => Promise.resolve(committedOutcome()));

    await harness.lifecycle.refresh();
    expect(harness.calls).toHaveLength(0);

    harness.setReady(true);
    await harness.lifecycle.refresh();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({ includeAdvanced: true, kind: 'overview' });

    harness.setDestinationScope(overviewScope('new scope'));
    const callsAfterDestinationChange = harness.calls.length;
    await harness.lifecycle.refresh();
    expect(harness.calls).toHaveLength(callsAfterDestinationChange + 1);
    expect(harness.calls.at(-1)).toMatchObject({ kind: 'overview', query: { filters: { query: 'new scope' } } });

    harness.dispose();
  });

  test('owns pending state from the initial destination until that operation succeeds', async () => {
    const initialRefresh = createDeferredRefresh();
    const harness = createLifecycleHarness(() => initialRefresh.promise);

    expect(harness.lifecycle.destinationPending()).toBe(false);
    harness.setReady(true);
    const pendingRefresh = harness.lifecycle.refresh();

    expect(harness.lifecycle.destinationPending()).toBe(true);
    initialRefresh.resolve(committedOutcome());
    await pendingRefresh;
    expect(harness.lifecycle.destinationPending()).toBe(false);

    harness.dispose();
  });

  test('keeps a changed destination pending while the previous snapshot is preserved', async () => {
    const refreshes: DeferredRefresh[] = [];
    const harness = createLifecycleHarness(() => {
      const refresh = createDeferredRefresh();
      refreshes.push(refresh);
      return refresh.promise;
    });

    harness.setReady(true);
    const initialRefresh = harness.lifecycle.refresh();
    refreshes[0]?.resolve(committedOutcome());
    await initialRefresh;

    harness.setDestinationScope(overviewScope('new scope'));
    const changedRefresh = harness.lifecycle.refresh();
    expect(harness.lifecycle.destinationPending()).toBe(true);

    refreshes.at(-1)?.resolve(committedOutcome());
    await changedRefresh;
    expect(harness.lifecycle.destinationPending()).toBe(false);

    harness.dispose();
  });

  test('refreshes a mismatched first publication and deduplicates every observed revision', () => {
    expect(transitionDashboardPublication(undefined, 'revision-a', true, 'revision-bootstrap')).toEqual({
      observedRevision: 'revision-a',
      refresh: true,
    });
    const initial = transitionDashboardPublication(undefined, 'revision-a', true, 'revision-a');
    expect(initial).toEqual({ observedRevision: 'revision-a', refresh: false });

    expect(transitionDashboardPublication(initial.observedRevision, 'revision-a', true, 'revision-bootstrap')).toEqual({
      observedRevision: 'revision-a',
      refresh: false,
    });
    const whileNotReady = transitionDashboardPublication(initial.observedRevision, 'revision-b', false, 'revision-a');
    expect(whileNotReady).toEqual({
      observedRevision: 'revision-b',
      refresh: false,
    });
    expect(transitionDashboardPublication(whileNotReady.observedRevision, 'revision-b', true, 'revision-a')).toEqual({
      observedRevision: 'revision-b',
      refresh: false,
    });
    expect(transitionDashboardPublication(initial.observedRevision, 'revision-b', true, 'revision-a')).toEqual({
      observedRevision: 'revision-b',
      refresh: true,
    });
  });

  test('suppresses failed advanced analysis only for the matching query scope', async () => {
    let refreshCount = 0;
    const harness = createLifecycleHarness((destination) => {
      refreshCount += 1;
      if (refreshCount === 1 && destination.kind === 'overview' && destination.includeAdvanced) {
        return Promise.resolve({
          error: new Error('Advanced analysis unavailable'),
          status: 'failed-preserving-previous',
        });
      }
      return Promise.resolve(committedOutcome());
    });

    harness.setReady(true);
    await harness.lifecycle.refresh();
    await harness.lifecycle.refresh();

    expect(
      harness.calls.map((destination) => (destination.kind === 'overview' ? destination.includeAdvanced : null)),
    ).toEqual([true, false]);
    expect(harness.lifecycle.advancedAnalysisError()).toBe('Advanced analysis unavailable');
    expect(harness.lifecycle.advancedAnalysisLoading()).toBe(false);
    expect(harness.lifecycle.focusedTimelineError()).toBeNull();
    expect(harness.errors).toEqual(['Advanced analysis unavailable']);

    harness.setDestinationScope(overviewScope('different scope'));
    await harness.lifecycle.refresh();

    expect(harness.calls.at(-1)).toMatchObject({ includeAdvanced: true, kind: 'overview' });
    expect(harness.lifecycle.advancedAnalysisError()).toBeNull();

    harness.dispose();
  });

  test('settles Overview loading state when refresh throws', async () => {
    const harness = createLifecycleHarness(() => Promise.reject(new Error('Overview transport failed')));

    harness.setReady(true);
    await harness.lifecycle.refresh();

    expect(harness.lifecycle.focusedTimelineLoading()).toBe(false);
    expect(harness.lifecycle.advancedAnalysisLoading()).toBe(false);
    expect(harness.lifecycle.sessionQueryLoading()).toBe(false);
    expect(harness.lifecycle.destinationPending()).toBe(false);
    expect(harness.lifecycle.focusedTimelineError()).toBe('Overview transport failed');
    expect(harness.lifecycle.advancedAnalysisError()).toBe('Overview transport failed');
    expect(harness.errors).toContain('Overview transport failed');

    harness.dispose();
  });

  test('settles Session loading state when the previous destination is preserved', async () => {
    const harness = createLifecycleHarness(() =>
      Promise.resolve({
        error: new Error('Session destination failed'),
        status: 'failed-preserving-previous',
      }),
    );

    harness.setDestinationScope(sessionsScope());
    harness.setReady(true);
    await harness.lifecycle.refresh();

    expect(harness.lifecycle.focusedTimelineLoading()).toBe(false);
    expect(harness.lifecycle.advancedAnalysisLoading()).toBe(false);
    expect(harness.lifecycle.sessionQueryLoading()).toBe(false);
    expect(harness.lifecycle.destinationPending()).toBe(false);
    expect(harness.lifecycle.focusedTimelineError()).toBe('Session destination failed');
    expect(harness.errors).toContain('Session destination failed');

    harness.dispose();
  });

  test('does not publish state from a superseded refresh', async () => {
    const harness = createLifecycleHarness(() => Promise.resolve({ status: 'superseded' }));

    harness.setReady(true);
    harness.lifecycle.requestTimeline({ dimension: 'model', granularity: 'week' });
    await harness.lifecycle.refresh();

    expect(harness.lifecycle.focusedTimelineLoading()).toBe(true);
    expect(harness.lifecycle.destinationPending()).toBe(true);
    expect(harness.lifecycle.advancedAnalysisLoading()).toBe(true);
    expect(harness.lifecycle.focusedTimelineError()).toBeNull();
    expect(harness.errors).toEqual([]);

    harness.dispose();
  });
  test('does not let a superseded operation clear the newer destination pending state', async () => {
    const firstRefresh = createDeferredRefresh();
    const secondRefresh = createDeferredRefresh();
    let refreshCount = 0;
    const harness = createLifecycleHarness(() => {
      refreshCount += 1;
      return refreshCount === 1 ? firstRefresh.promise : secondRefresh.promise;
    });

    harness.setReady(true);
    const firstOperation = harness.lifecycle.refresh();
    harness.setDestinationScope(overviewScope('new scope'));
    const secondOperation = harness.lifecycle.refresh();

    firstRefresh.resolve({ status: 'superseded' });
    await firstOperation;
    expect(harness.lifecycle.destinationPending()).toBe(true);

    secondRefresh.resolve(committedOutcome());
    await secondOperation;
    expect(harness.lifecycle.destinationPending()).toBe(false);

    harness.dispose();
  });

  test('coordinates campaign, machine, and origin timeline destinations', async () => {
    const harness = createLifecycleHarness(() => Promise.resolve(committedOutcome()));
    harness.setReady(true);

    for (const dimension of ['campaign', 'machine', 'origin'] as const) {
      harness.lifecycle.requestTimeline({ dimension, granularity: 'day' });
      await harness.lifecycle.refresh();
      expect(harness.calls.at(-1)?.timeline).toEqual({ dimension, granularity: 'day' });
    }

    harness.dispose();
  });

  test('aborts report work, closes session queries, and ignores a late result on cleanup', async () => {
    let resolveRefresh: ((outcome: RefreshOutcome) => void) | undefined;
    const harness = createLifecycleHarness(
      () =>
        new Promise<RefreshOutcome>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    harness.setReady(true);
    const pendingRefresh = harness.lifecycle.refresh();
    expect(harness.calls).toHaveLength(1);
    expect(harness.lifecycle.destinationPending()).toBe(true);

    harness.dispose();
    expect(harness.lifecycle.destinationPending()).toBe(false);
    expect(harness.abortCount()).toBe(1);
    expect(harness.closeCount()).toBe(1);
    resolveRefresh?.(committedOutcome());
    await pendingRefresh;

    expect(harness.lifecycle.focusedTimelineLoading()).toBe(true);
    expect(harness.lifecycle.advancedAnalysisLoading()).toBe(true);
  });
});
