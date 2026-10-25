import { describe, expect, test } from 'bun:test';
import type { DelegationJobsOutput, DelegationJobViewWire } from '@ai-usage/web-contract/delegation';
import type { DelegationClientResult } from '../../rpc/delegation-client';
import { createWebQueryClient } from '../client';
import {
  createDelegationMutations,
  DELEGATION_JOBS_IDLE_REFETCH_MS,
  DELEGATION_JOBS_LIVE_REFETCH_MS,
  delegationJobIsLive,
  delegationJobKey,
  delegationJobQueryOptions,
  delegationJobsHaveLive,
  delegationJobsKey,
  delegationJobsQueryOptions,
  delegationSettingsKey,
  delegationSettingsQueryOptions,
} from './delegation';

const JOB_ID = '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f';

const job = (state: DelegationJobViewWire['state'], live: boolean): DelegationJobViewWire => ({
  attemptNumber: 1,
  cancelRequestedAt: null,
  endedAt: null,
  evaluations: { acceptance: null, acceptances: [], automatedChecks: [], verifications: [] },
  executedScope: null,
  failure: null,
  guarantee: null,
  heartbeatAgeSeconds: live ? 3 : null,
  jobId: JOB_ID,
  live,
  machineId: 'm',
  notes: [],
  qualification: null,
  refusal: null,
  request: {
    action: 'read-only-review',
    checkoutPath: '/home/operator/src',
    constraints: [],
    criteria: [],
    objective: 'Review.',
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'tests',
  },
  requestedAt: '2026-10-25T09:00:00.000Z',
  reservation: { evidence: null, held: live, releasedAt: null },
  result: null,
  retryOf: null,
  route: null,
  selection: null,
  startedAt: null,
  state,
  status: { accepted: 'pending', executed: live ? 'running' : 'succeeded', verified: 'not-verified' },
  truncation: { evaluations: 0, evidence: 0, findings: 0, notReviewed: 0 },
  updatedAt: '2026-10-25T09:00:00.000Z',
  usage: null,
});

const listed = (jobs: DelegationJobViewWire[]): DelegationClientResult<DelegationJobsOutput> => ({
  data: { jobs, omitted: 0, skipped: 0 },
  ok: true,
});

describe('Delegation Query options', () => {
  test('settings is a bounded control-plane identity read on mount', async () => {
    const client = createWebQueryClient();
    const signals: AbortSignal[] = [];
    const options = delegationSettingsQueryOptions(
      {
        settings: ({ signal } = {}) => {
          if (signal) {
            signals.push(signal);
          }
          return Promise.resolve({ error: { message: 'x', tag: 'Unavailable' }, ok: false });
        },
      },
      { browser: true, enabled: true },
    );
    await client.fetchQuery(options);
    expect(signals).toHaveLength(1);
    expect(options).toMatchObject({
      enabled: true,
      queryKey: ['web', 'control-plane', 'delegation', 'settings', 'v1'],
      refetchOnMount: true,
      retry: false,
      staleTime: 5000,
    });
    expect(
      delegationSettingsQueryOptions(
        { settings: () => Promise.reject(new Error('x')) },
        { browser: false, enabled: true },
      ).enabled,
    ).toBe(false);
  });

  test('jobs lists poll fast while a job is live and slowly otherwise; job details poll only while live', async () => {
    const client = createWebQueryClient();
    const inputs: unknown[] = [];
    const options = delegationJobsQueryOptions(
      {
        jobs: (input) => {
          inputs.push(input);
          return Promise.resolve(listed([job('running', true)]));
        },
      },
      { limit: 20 },
      { browser: true, enabled: true },
    );
    await client.fetchQuery(options);
    expect(inputs).toEqual([{ limit: 20 }]);
    expect(options).toMatchObject({
      queryKey: ['web', 'finite-swr', 'delegation', 'jobs', 20, 'all'],
      refetchOnMount: true,
      retry: false,
    });
    expect(delegationJobsKey({ liveOnly: true })).toEqual(['web', 'finite-swr', 'delegation', 'jobs', 20, 'live']);
    const interval = options.refetchInterval;
    if (typeof interval !== 'function') {
      throw new Error('refetchInterval must be computed from the data');
    }
    const query = client.getQueryCache().find({ queryKey: options.queryKey });
    if (!query) {
      throw new Error('query must exist after fetch');
    }
    expect(interval(query as never)).toBe(DELEGATION_JOBS_LIVE_REFETCH_MS);
    // Nothing live: the list still polls, slowly, so a job started by an MCP client or the CLI appears.
    const idle = delegationJobsQueryOptions(
      { jobs: () => Promise.resolve(listed([job('finished', false)])) },
      { limit: 10 },
      { browser: true, enabled: true },
    );
    await client.fetchQuery(idle);
    const idleQuery = client.getQueryCache().find({ queryKey: idle.queryKey });
    if (typeof idle.refetchInterval !== 'function' || !idleQuery) {
      throw new Error('the idle refetchInterval must be computed from the data');
    }
    expect(idle.refetchInterval(idleQuery as never)).toBe(DELEGATION_JOBS_IDLE_REFETCH_MS);
    expect(DELEGATION_JOBS_IDLE_REFETCH_MS).toBe(30_000);
    expect(DELEGATION_JOBS_LIVE_REFETCH_MS).toBe(5000);
    expect(delegationJobsHaveLive(listed([job('finished', false), job('lost', false)]))).toBe(false);
    expect(delegationJobsHaveLive(listed([job('finished', false), job('starting', true)]))).toBe(true);
    expect(delegationJobsHaveLive({ error: { message: 'x', tag: 'Unavailable' }, ok: false })).toBe(false);
    expect(delegationJobsHaveLive(undefined)).toBe(false);

    const detail = delegationJobQueryOptions(
      { job: () => Promise.resolve({ data: job('finished', false), ok: true }) },
      JOB_ID,
      { browser: true, enabled: true },
    );
    expect([...detail.queryKey]).toEqual([...delegationJobKey(JOB_ID)]);
    expect([...detail.queryKey]).toEqual(['web', 'finite-swr', 'delegation', 'job', JOB_ID]);
    await client.fetchQuery(detail);
    const detailQuery = client.getQueryCache().find({ queryKey: detail.queryKey });
    const detailInterval = detail.refetchInterval;
    if (typeof detailInterval !== 'function' || !detailQuery) {
      throw new Error('detail refetchInterval must be computed from the data');
    }
    expect(detailInterval(detailQuery as never)).toBe(false);
    expect(delegationJobIsLive({ data: job('running', true), ok: true })).toBe(true);
    expect(delegationJobIsLive(undefined)).toBe(false);
  });

  test('mutations invalidate exactly settings after a save and the jobs after a cancel or an acceptance', async () => {
    const client = createWebQueryClient();
    const settingsKey = delegationSettingsKey();
    const listKey = delegationJobsKey({ limit: 20 });
    const otherListKey = delegationJobsKey({ liveOnly: true });
    const detailKey = delegationJobKey(JOB_ID);
    const unrelated = ['web', 'finite-swr', 'work-attempts', 'list'] as const;
    const seed = () => {
      for (const key of [settingsKey, listKey, otherListKey, detailKey, unrelated]) {
        client.setQueryData(key, 'seeded');
      }
    };
    const invalidated = () =>
      [settingsKey, listKey, otherListKey, detailKey, unrelated].map(
        (key) => client.getQueryState(key)?.isInvalidated === true,
      );
    const mutations = createDelegationMutations(client, {
      cancel: () => Promise.resolve({ data: { jobId: JOB_ID, result: 'cancelling', state: 'running' }, ok: true }),
      recordAcceptance: () => Promise.resolve({ data: { evaluationId: 'eval-1' }, ok: true }),
      saveSettings: () =>
        Promise.resolve({ data: { issues: [], result: 'written', revision: 'a'.repeat(16) }, ok: true }),
    });
    seed();
    await mutations.saveSettings({ delegation: {}, expectedRevision: 'b'.repeat(16) });
    expect(invalidated()).toEqual([true, false, false, false, false]);
    seed();
    await mutations.cancel({ jobId: JOB_ID });
    expect(invalidated()).toEqual([false, true, true, true, false]);
    seed();
    await mutations.recordAcceptance({ jobId: JOB_ID, verdict: 'accepted' });
    expect(invalidated()).toEqual([false, true, true, true, false]);

    const failing = createDelegationMutations(client, {
      cancel: () => Promise.resolve({ error: { message: 'down', tag: 'EngineUnavailable' }, ok: false }),
      recordAcceptance: () => Promise.resolve({ error: { message: 'not ended', tag: 'Conflict' }, ok: false }),
      saveSettings: () =>
        Promise.resolve({ error: { message: 'moved', revision: 'c'.repeat(16), tag: 'Conflict' }, ok: false }),
    });
    seed();
    await failing.cancel({ jobId: JOB_ID });
    await failing.recordAcceptance({ jobId: JOB_ID, verdict: 'rejected' });
    expect(invalidated()).toEqual([false, false, false, false, false]);
    // A conflict means the settings on disk moved: the page re-reads them.
    await failing.saveSettings({ delegation: {}, expectedRevision: 'b'.repeat(16) });
    expect(invalidated()).toEqual([true, false, false, false, false]);
    client.clear();
  });
});
