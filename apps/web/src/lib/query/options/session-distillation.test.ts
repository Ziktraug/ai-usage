import { describe, expect, test } from 'bun:test';
import type { DistillationStatus } from '@ai-usage/web-contract/session-distillation';
import { QueryObserver } from '@tanstack/svelte-query';
import type { SessionDistillationClient } from '../../rpc/session-distillation-client';
import { createWebQueryClient } from '../client';
import { createPublicationQueryInvalidator } from '../composition';
import {
  sessionDistillationEvidenceKey,
  sessionDistillationEvidenceOptions,
  sessionDistillationGetKey,
  sessionDistillationStatusKey,
  sessionDistillationStatusOptions,
} from './session-distillation';

const selection = { revision: 'report-1', rowId: 'row-1' };
const statusRequest = { kind: 'status' as const, selection };
const empty: DistillationStatus = {
  state: 'not-analyzed',
  latest: null,
  revisions: [],
  revisionsOmitted: 0,
  job: null,
  sourceStatus: 'unchecked',
};
const unused = (): Promise<never> => Promise.reject(new Error('Unexpected Session distillation call'));

describe('Session distillation Query ownership', () => {
  test('does not acquire data during SSR, before selection, or while the Analysis tab is hidden', async () => {
    let calls = 0;
    const client: SessionDistillationClient = {
      evidence: unused,
      get: unused,
      status: () => {
        calls += 1;
        return Promise.resolve(empty);
      },
    };
    const queryClient = createWebQueryClient();
    for (const options of [
      sessionDistillationStatusOptions(client, statusRequest, { browser: false, active: true }),
      sessionDistillationStatusOptions(client, statusRequest, { browser: true, active: false }),
      sessionDistillationStatusOptions(client, undefined, { browser: true, active: true }),
    ]) {
      const observer = new QueryObserver(queryClient, options);
      const unsubscribe = observer.subscribe(() => undefined);
      await Promise.resolve();
      unsubscribe();
    }
    expect(calls).toBe(0);
    queryClient.clear();
  });

  test('never carries another session status and does not invalidate analyses on report publication', async () => {
    const client: SessionDistillationClient = {
      evidence: unused,
      get: unused,
      status: () => new Promise(() => undefined),
    };
    const queryClient = createWebQueryClient();
    const initial = sessionDistillationStatusOptions(client, statusRequest, { browser: true, active: true });
    queryClient.setQueryData(initial.queryKey, empty);
    const observer = new QueryObserver(queryClient, initial);
    const unsubscribe = observer.subscribe(() => undefined);
    const analysisKey = sessionDistillationGetKey({ kind: 'get', selection, analysisId: 'analysis-1' });
    queryClient.setQueryData(analysisKey, 'pinned-analysis');
    observer.setOptions(
      sessionDistillationStatusOptions(
        client,
        { kind: 'status', selection: { ...selection, rowId: 'row-2' } },
        { browser: true, active: true },
      ),
    );
    expect(observer.getCurrentResult().data).toBeUndefined();
    await createPublicationQueryInvalidator(queryClient)('report-2');
    expect(queryClient.getQueryState(analysisKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(sessionDistillationStatusKey(statusRequest))?.isInvalidated).toBe(false);
    unsubscribe();
    queryClient.clear();
  });

  test('keys exact revisions and evidence selections separately while source reads remain revalidatable', () => {
    const first = { kind: 'evidence' as const, selection, analysisId: 'analysis-1', eventIds: ['event-1'] };
    expect(sessionDistillationEvidenceKey(first)).not.toEqual(
      sessionDistillationEvidenceKey({ ...first, eventIds: ['event-2'] }),
    );
    expect(sessionDistillationGetKey({ kind: 'get', selection, analysisId: 'analysis-1' })).not.toEqual(
      sessionDistillationGetKey({ kind: 'get', selection, analysisId: 'analysis-2' }),
    );
    const client: SessionDistillationClient = { evidence: unused, get: unused, status: unused };
    const options = sessionDistillationEvidenceOptions(client, first, { browser: true, active: true });
    expect(options.staleTime).toBe(30_000);
    expect(options.refetchOnWindowFocus).toBe(false);
  });
});
