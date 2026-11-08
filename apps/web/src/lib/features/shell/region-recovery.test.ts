import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ORPCError } from '@orpc/client';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../../query/client';
import { quotaRailQueryOptions, resetQuotaRailForRecovery } from '../../query/options/quota';
import { recoverRegion } from './report-render-error';

test('the quota boundary owner propagates a failed active query reset instead of resetting the boundary', async () => {
  const queryClient = createWebQueryClient();
  const failure = new ORPCError('Unavailable');
  const options = quotaRailQueryOptions(
    { getProviderQuotaHistory: () => Promise.reject(failure) },
    { browser: true, enabled: true },
  );
  const observer = new QueryObserver(queryClient, options);
  const unsubscribe = observer.subscribe(() => undefined);
  const reset = mock(() => undefined);
  try {
    await expect(recoverRegion(reset, () => resetQuotaRailForRecovery(queryClient))).rejects.toBe(failure);
    expect(reset).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    queryClient.clear();
  }
});

test('a failed boundary refetches before resetting; a rejected retry leaves its unavailable UI intact', async () => {
  const events: string[] = [];
  await recoverRegion(
    () => events.push('reset'),
    () => {
      events.push('refetch');
      return Promise.resolve();
    },
  );
  expect(events).toEqual(['refetch', 'reset']);
  const reset = mock(() => undefined);
  const failure = new Error('Read unavailable');
  await expect(recoverRegion(reset, () => Promise.reject(failure))).rejects.toBe(failure);
  expect(reset).not.toHaveBeenCalled();
});

test('recovery owners use in-app query/routing recovery, never a document reload', async () => {
  const session = await readFile(
    new URL('../sessions/detail/session-detail-query-slot.svelte', import.meta.url),
    'utf8',
  );
  const route = await readFile(new URL('./error-route-owner.svelte', import.meta.url), 'utf8');
  expect(session).not.toContain('location.reload');
  expect(route).not.toContain('location.reload');
  expect(session).toContain('queryClient.resetQueries({ queryKey, exact: true }, { throwOnError: true })');
  expect(route).toContain('refreshAll: true, replace: true');
});
