import { parseSessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { sessionPagesInfiniteOptions } from './session-window';

export const WORK_PAGE_SIZE = 25;
export const workRequest = (revision: string) =>
  parseSessionQueryRequest({
    revision,
    cursor: null,
    pageSize: WORK_PAGE_SIZE,
    range: { from: null, to: null },
    filters: { fields: {}, harness: [], machine: [], query: '' },
    sort: [{ id: 'date', desc: true }],
  });

/** Shares the exact Session identity and immutable-revision policy with the report. */
export const workSessionsOptions = (client: SessionClientAdapter, revision: string) =>
  sessionPagesInfiniteOptions(client, workRequest(revision), revision);
