import {
  DELEGATION_WEB_BOUNDS,
  type DelegationCancelInput,
  type DelegationCancelOutput,
  type DelegationJobsInput,
  type DelegationJobsOutput,
  type DelegationJobViewWire,
  type DelegationRecordAcceptanceInput,
  type DelegationRecordAcceptanceOutput,
  type DelegationSaveSettingsInput,
  type DelegationSaveSettingsOutput,
} from '@ai-usage/web-contract/delegation';
import { type QueryClient, queryOptions } from '@tanstack/svelte-query';
import type {
  DelegationClient,
  DelegationClientCallOptions,
  DelegationClientResult,
} from '../../rpc/delegation-client';
import { type ControlPlaneQueryKey, controlPlaneKey, type FiniteSwrQueryKey, finiteSwrKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type DelegationSettingsQueryClient = Pick<DelegationClient, 'settings'>;
export type DelegationJobsQueryClient = Pick<DelegationClient, 'jobs'>;
export type DelegationJobQueryClient = Pick<DelegationClient, 'job'>;
export type DelegationMutationClient = Pick<DelegationClient, 'cancel' | 'recordAcceptance' | 'saveSettings'>;

export interface DelegationQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

/** While a listed job (or the detail's job) is live, the list or the detail is re-read on this interval. */
export const DELEGATION_JOBS_LIVE_REFETCH_MS = 5000;
/**
 * The list's interval once nothing listed is live: jobs are started by MCP clients and the CLI, never
 * by this page, so work started elsewhere (and a verification recorded there) must still appear. The
 * detail stops polling when its job ends; the list never stops.
 */
export const DELEGATION_JOBS_IDLE_REFETCH_MS = 30_000;

/**
 * The policy is the operator's control-plane state: read on mount, short stale time, written only
 * through `saveSettings`, which invalidates exactly this identity.
 */
export const delegationSettingsKey = (): ControlPlaneQueryKey => controlPlaneKey('delegation', 'settings', 'v1');

/** Prefix of every jobs list identity, for invalidation. */
export const delegationJobsScopeKey = (): FiniteSwrQueryKey => finiteSwrKey('delegation', 'jobs');

export const delegationJobsKey = (input: DelegationJobsInput): FiniteSwrQueryKey =>
  finiteSwrKey(
    'delegation',
    'jobs',
    input.limit ?? DELEGATION_WEB_BOUNDS.defaultListLimit,
    input.liveOnly === true ? 'live' : 'all',
  );

/** Prefix of every job detail identity, for invalidation; `job` is not a prefix of `jobs`. */
export const delegationJobScopeKey = (): FiniteSwrQueryKey => finiteSwrKey('delegation', 'job');

export const delegationJobKey = (jobId: string): FiniteSwrQueryKey => finiteSwrKey('delegation', 'job', jobId);

export const delegationJobsHaveLive = (result: DelegationClientResult<DelegationJobsOutput> | undefined): boolean =>
  result?.ok === true && result.data.jobs.some((job) => job.live);

export const delegationJobIsLive = (result: DelegationClientResult<DelegationJobViewWire> | undefined): boolean =>
  result?.ok === true && result.data.live;

export const delegationSettingsQueryOptions = (
  client: DelegationSettingsQueryClient,
  context: DelegationQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.settings({ signal }),
    queryKey: delegationSettingsKey(),
  });

/**
 * One identity per (limit, liveOnly). Finite SWR, with one addition: the list polls every five
 * seconds while a live job (requested, starting, running) is listed, and every thirty seconds
 * otherwise, because a job is started by an MCP client or the CLI and would otherwise never appear
 * here until the operator acted.
 */
export const delegationJobsQueryOptions = (
  client: DelegationJobsQueryClient,
  input: DelegationJobsInput,
  context: DelegationQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.jobs(input, { signal }),
    queryKey: delegationJobsKey(input),
    refetchInterval: (query) =>
      delegationJobsHaveLive(query.state.data) ? DELEGATION_JOBS_LIVE_REFETCH_MS : DELEGATION_JOBS_IDLE_REFETCH_MS,
  });

/** One job's detail polls every five seconds while that job is live and stops by itself once it ended. */

export const delegationJobQueryOptions = (
  client: DelegationJobQueryClient,
  jobId: string,
  context: DelegationQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.job({ jobId }, { signal }),
    queryKey: delegationJobKey(jobId),
    refetchInterval: (query) => (delegationJobIsLive(query.state.data) ? DELEGATION_JOBS_LIVE_REFETCH_MS : false),
  });

export const invalidateDelegationSettings = async (queryClient: QueryClient): Promise<void> => {
  await queryClient.invalidateQueries({ exact: true, queryKey: delegationSettingsKey() });
};

/** Every jobs list and every job detail: a cancel or an acceptance changes a job and nothing else. */
export const invalidateDelegationJobs = async (queryClient: QueryClient): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: delegationJobsScopeKey() }),
    queryClient.invalidateQueries({ queryKey: delegationJobScopeKey() }),
  ]);
};

export interface DelegationMutations {
  readonly cancel: (
    input: DelegationCancelInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationCancelOutput>>;
  readonly recordAcceptance: (
    input: DelegationRecordAcceptanceInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationRecordAcceptanceOutput>>;
  readonly saveSettings: (
    input: DelegationSaveSettingsInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationSaveSettingsOutput>>;
}

/**
 * The three mutations with their exact invalidations: a written save (or a conflict, which means
 * the settings on disk moved) invalidates `settings`; a recorded cancel or acceptance invalidates
 * the jobs lists and job details. A failed call invalidates nothing.
 */
export const createDelegationMutations = (
  queryClient: QueryClient,
  client: DelegationMutationClient,
): DelegationMutations => ({
  cancel: async (input, options) => {
    const result = await client.cancel(input, options);
    if (result.ok) {
      await invalidateDelegationJobs(queryClient);
    }
    return result;
  },
  recordAcceptance: async (input, options) => {
    const result = await client.recordAcceptance(input, options);
    if (result.ok) {
      await invalidateDelegationJobs(queryClient);
    }
    return result;
  },
  saveSettings: async (input, options) => {
    const result = await client.saveSettings(input, options);
    if (result.ok || result.error.tag === 'Conflict') {
      await invalidateDelegationSettings(queryClient);
    }
    return result;
  },
});
