import { isLiveReviewAttemptState } from '@ai-usage/report-core/work-attempts';
import type { WorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import { queryOptions } from '@tanstack/svelte-query';
import type { WorkAttemptsClient } from '../../rpc/work-attempts-client';
import { type FiniteSwrQueryKey, finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type WorkAttemptsQueryClient = Pick<WorkAttemptsClient, 'list'>;

export interface WorkAttemptsTarget {
  readonly harness: string;
  readonly sourceSessionId: string;
}

export interface WorkAttemptsQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

/** Attempts one target shows; the newest first, bounded by the contract. */
export const WORK_ATTEMPTS_LIST_LIMIT = 20;
/** While an attempt is live the list is re-read on this interval; once none is, nothing polls. */
export const WORK_ATTEMPTS_LIVE_REFETCH_MS = 5000;

export const workAttemptsKey = (target: WorkAttemptsTarget): FiniteSwrQueryKey =>
  finiteSwrKey('work-attempts', 'list', target.harness, target.sourceSessionId);

export const workAttemptsHaveLive = (output: WorkAttemptsListOutput | undefined): boolean =>
  output?.ok === true && output.data.attempts.some((attempt) => isLiveReviewAttemptState(attempt.state));

/**
 * Its own identity per target session. Finite SWR, with one addition: a live attempt (requested,
 * starting, running) is the only state that changes without the operator acting, so the list polls
 * every five seconds exactly while one exists and stops by itself when it ends.
 */
export const workAttemptsQueryOptions = (
  client: WorkAttemptsQueryClient,
  target: WorkAttemptsTarget,
  context: WorkAttemptsQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.list({ limit: WORK_ATTEMPTS_LIST_LIMIT, target }, { signal }),
    queryKey: workAttemptsKey(target),
    refetchInterval: (query) => (workAttemptsHaveLive(query.state.data) ? WORK_ATTEMPTS_LIVE_REFETCH_MS : false),
  });
