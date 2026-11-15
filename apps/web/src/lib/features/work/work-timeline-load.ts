import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  WORK_THREAD_TABS,
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import type { WorkThreadsClient } from '../../rpc/work-threads-client';

/** Per tab, pages of WORK_THREAD_VIEW_BOUNDS.maxPageSize: the timeline reads a bounded history, not all of it. */
export const TIMELINE_MAX_PAGES = 10;

export interface WorkTimelineDataset {
  /** Every page of both tabs was read (no page cap hit). */
  readonly complete: boolean;
  readonly counts: { readonly done: number; readonly open: number };
  /** The first page's. */
  readonly generatedAt: CanonicalInstant;
  readonly loaded: { readonly done: number; readonly open: number };
  readonly projects: readonly string[];
  /**
   * threadId → the source statuses of the page that row was kept from. A task's situation is
   * qualified by these, as the task list does, never by the merged `sources`: one page that could
   * not read a source says nothing about the tasks of the other pages.
   */
  readonly rowSources: ReadonlyMap<string, readonly WorkThreadSourceStatus[]>;
  /** Followed tasks then ended follow-ups, deduplicated by threadId. */
  readonly rows: readonly WorkThreadRow[];
  /**
   * For display. Per source: the first page's status, replaced by a later page's when that one is
   * not 'ok' and the kept one is.
   */
  readonly sources: readonly WorkThreadSourceStatus[];
}
export type WorkTimelineResult =
  | { readonly ok: true; readonly data: WorkTimelineDataset }
  | { readonly ok: false; readonly error: { readonly message: string } };

/**
 * Follows `nextCursor` through the existing list read for the `open` then the `done` tab. Any
 * failed page fails the whole read (a partial timeline would read as "nothing happened").
 */
export const readWorkTimeline = async (
  client: Pick<WorkThreadsClient, 'list'>,
  filter: { readonly project: string | null; readonly search: string | null },
  options: { readonly signal?: AbortSignal } = {},
): Promise<WorkTimelineResult> => {
  const rows = new Map<string, WorkThreadRow>();
  const rowSources = new Map<string, readonly WorkThreadSourceStatus[]>();
  const sources = new Map<WorkThreadSourceStatus['source'], WorkThreadSourceStatus>();
  const loaded = { done: 0, open: 0 };
  let first: Pick<WorkTimelineDataset, 'counts' | 'generatedAt' | 'projects'> | null = null;
  let complete = true;
  for (const tab of WORK_THREAD_TABS) {
    let cursor: string | null = null;
    for (let page = 0; page < TIMELINE_MAX_PAGES; page++) {
      // An abandoned read stops following cursors instead of finishing twenty requests for nobody.
      options.signal?.throwIfAborted();
      const result = await client.list(
        { cursor, limit: WORK_THREAD_VIEW_BOUNDS.maxPageSize, project: filter.project, search: filter.search, tab },
        options,
      );
      if (!result.ok) {
        return { ok: false, error: { message: result.error.message } };
      }
      const { data } = result;
      first ??= { counts: data.counts, generatedAt: data.generatedAt, projects: data.projects };
      for (const row of data.rows) {
        if (!rows.has(row.thread.threadId)) {
          rows.set(row.thread.threadId, row);
          rowSources.set(row.thread.threadId, data.sources);
          loaded[tab] += 1;
        }
      }
      for (const status of data.sources) {
        const kept = sources.get(status.source);
        if (kept === undefined || (kept.state === 'ok' && status.state !== 'ok')) {
          sources.set(status.source, status);
        }
      }
      cursor = data.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    if (cursor !== null) {
      complete = false;
    }
  }
  if (first === null) {
    throw new RangeError('The task timeline read no page.');
  }
  return {
    ok: true,
    data: { ...first, complete, loaded, rows: [...rows.values()], rowSources, sources: [...sources.values()] },
  };
};
