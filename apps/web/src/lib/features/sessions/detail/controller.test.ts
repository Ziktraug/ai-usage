import { describe, expect, test } from 'bun:test';
import { parseSessionQueryRequest } from '@ai-usage/report-core/session-query';
import { syntheticSessionRows } from '../table/session-table.fixtures';
import { createSessionDetailController, type SessionDetailControllerSnapshot } from './controller';
import type { SessionDetailQueryOwner } from './query-owner';

const rows = syntheticSessionRows(3);
const first = rows[0]!;
const second = rows[1]!;
const third = rows[2]!;
const query = parseSessionQueryRequest({
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  pageSize: 25,
  range: { from: null, to: null },
  revision: 'revision-p4',
  sort: [{ desc: true, id: 'date' }],
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const queryOwner = (overrides: Partial<SessionDetailQueryOwner> = {}): SessionDetailQueryOwner => ({
  close: () => undefined,
  loadDetail: () => Promise.resolve(undefined),
  loadNeighbors: () => Promise.resolve(undefined),
  loadVcs: () => Promise.resolve(undefined),
  resetDetail: () => undefined,
  resetVcs: () => undefined,
  ...overrides,
});

const keyboard = (key: string, target: EventTarget | null = null) => {
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

describe('P4 Session detail controller', () => {
  test('preserves one local row identity across next/previous/Escape and ignores editable targets', () => {
    const selected: (string | null)[] = [];
    const controller = createSessionDetailController({
      onSelectedRowId: (rowId) => selected.push(rowId),
      query: queryOwner(),
      rows: () => rows,
    });
    const snapshots: SessionDetailControllerSnapshot[] = [];
    const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));

    controller.select({ row: first });
    const editable = keyboard('j', { tagName: 'TEXTAREA' } as unknown as EventTarget);
    controller.handleKeyDown(editable.event);
    expect(controller.current().row?.rowId).toBe(first.rowId);
    expect(editable.prevented()).toBe(false);

    const next = keyboard('ArrowDown');
    controller.handleKeyDown(next.event);
    expect(next.prevented()).toBe(true);
    expect(controller.current().row?.rowId).toBe(second.rowId);
    controller.navigate(1);
    expect(controller.current().row?.rowId).toBe(third.rowId);
    controller.navigate(-1);
    expect(controller.current().row?.rowId).toBe(second.rowId);
    controller.handleKeyDown(keyboard('Escape').event);
    expect(controller.current().row).toBeNull();
    expect(selected).toEqual([first.rowId, second.rowId, third.rowId, second.rowId, null]);
    expect(snapshots.at(-1)?.target).toBeNull();

    unsubscribe();
    controller.dispose();
  });

  test('navigates only through exact served neighbors and ignores stale neighbor completion', async () => {
    const firstNeighbors = Promise.withResolvers<{
      found: true;
      next: typeof second;
      previous: null;
      requestFingerprint: string;
      revision: string;
    }>();
    const controller = createSessionDetailController({
      query: queryOwner({
        loadNeighbors: ({ rowId }) => {
          if (rowId === first.rowId) {
            return firstNeighbors.promise;
          }
          return Promise.resolve({
            found: true,
            next: rowId === second.rowId ? third : null,
            previous: first,
            requestFingerprint: `fixture:${rowId}`,
            revision: query.revision,
          });
        },
      }),
      rows: () => [first],
    });

    controller.select({ query, row: first, total: 3000 });
    controller.select({ query, row: second, total: 3000 });
    await flush();
    expect(controller.current().navigation).toMatchObject({
      loading: false,
      next: third,
      previous: first,
      total: 3000,
    });
    firstNeighbors.resolve({
      found: true,
      next: second,
      previous: null,
      requestFingerprint: 'stale-first',
      revision: query.revision,
    });
    await flush();
    expect(controller.current().row?.rowId).toBe(second.rowId);
    expect(controller.current().navigation?.next?.rowId).toBe(third.rowId);

    controller.navigate(1);
    expect(controller.current().row?.rowId).toBe(third.rowId);
    controller.dispose();
  });

  test('keeps detail and VCS operations concurrent, classifies failures, and resets on replacement', async () => {
    const detail = Promise.withResolvers<{
      message: string;
      reason: 'history-unavailable';
      status: 'unavailable';
    }>();
    const vcs = Promise.withResolvers<{ reason: 'timed-out'; status: 'unavailable' }>();
    const controller = createSessionDetailController({
      query: queryOwner({
        loadDetail: () => detail.promise,
        loadNeighbors: () => Promise.resolve(undefined),
        loadVcs: () => vcs.promise,
      }),
      rows: () => rows,
    });
    controller.select({ query, row: first });
    const analysisPending = controller.toggleAnalysis();
    const vcsPending = controller.resolveVcs();
    detail.resolve({
      message: 'Synthetic history service unavailable',
      reason: 'history-unavailable',
      status: 'unavailable',
    });
    vcs.resolve({ reason: 'timed-out', status: 'unavailable' });
    await Promise.all([analysisPending, vcsPending]);
    expect(controller.current()).toMatchObject({
      analysisLoading: false,
      analysisOpen: true,
      analysisResponse: { reason: 'history-unavailable', status: 'unavailable' },
      vcsResolution: { reason: 'timed-out', status: 'unavailable' },
      vcsResolving: false,
    });

    controller.select({ query, row: second });
    expect(controller.current()).toMatchObject({
      analysisOpen: false,
      analysisResponse: null,
      row: second,
      vcsResolution: null,
    });
    controller.dispose();
  });

  test('exposes transient failures for Retry without inventing terminal semantics', async () => {
    const controller = createSessionDetailController({
      query: queryOwner({
        loadDetail: () => Promise.reject(new Error('Synthetic connection reset')),
        loadNeighbors: () => Promise.resolve(undefined),
      }),
      rows: () => rows,
    });
    controller.select({ query, row: first });
    await controller.toggleAnalysis();
    expect(controller.current()).toMatchObject({
      analysisError: { kind: 'transient', message: 'Synthetic connection reset' },
      analysisLoading: false,
      analysisOpen: true,
    });
    controller.dispose();
  });
});
