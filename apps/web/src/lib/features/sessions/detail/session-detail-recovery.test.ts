import { expect, mock, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../../../query/client';
import { optionalSessionDetailQueryOptions } from '../../../query/options/session';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import { createLazyModuleLoader } from '../../report/composition/lazy-module-loader';
import { recoverRegion } from '../../shell/report-render-error';
import { createSessionDetailRecovery } from './session-detail-recovery';

const fixture = async () => {
  const client = createWebQueryClient();
  const failure = new ORPCError('Unavailable');
  let failDetail = true;
  const calls = { detail: 0, vcs: 0, neighbors: 0, members: 0 };
  const detail = new QueryObserver(client, {
    queryKey: ['detail'],
    retry: false,
    queryFn: () => {
      calls.detail++;
      return failDetail ? Promise.reject(failure) : Promise.resolve('detail available');
    },
  });
  const vcs = new QueryObserver(client, {
    queryKey: ['vcs'],
    retry: false,
    queryFn: () => {
      calls.vcs++;
      return Promise.reject(failure);
    },
  });
  const others = (['neighbors', 'members'] as const).map(
    (key) =>
      new QueryObserver(client, {
        queryKey: [key],
        retry: false,
        queryFn: () => {
          calls[key]++;
          return Promise.resolve(key);
        },
      }),
  );
  const stops = [
    detail.subscribe(() => undefined),
    vcs.subscribe(() => undefined),
    ...others.map((observer) => observer.subscribe(() => undefined)),
  ];
  await Promise.all([detail.refetch(), vcs.refetch(), ...others.map((observer) => observer.refetch())]);
  let failChunk = true;
  const importModule = mock(() =>
    failChunk ? Promise.reject(new Error('Chunk unavailable')) : Promise.resolve('drawer'),
  );
  const onLoaded = mock((_module: string) => undefined);
  const onFailureChange = mock((_failed: boolean) => undefined);
  const drawer = createLazyModuleLoader({ importModule, onLoaded, onFailureChange });
  return {
    calls,
    client,
    detail,
    drawer,
    failure,
    importModule,
    onLoaded,
    onFailureChange,
    vcs,
    recovery: createSessionDetailRecovery(detail, drawer, () => true),
    allowChunk: () => {
      failChunk = false;
    },
    allowDetail: () => {
      failDetail = false;
    },
    dispose: () => {
      for (const stop of stops) {
        stop();
      }
      client.clear();
    },
  };
};

test('chunk retry succeeds while detail still fails, and a repeated chunk failure stays visible', async () => {
  const state = await fixture();
  try {
    expect(await state.drawer.load()).toBe('failed');
    await state.recovery.retryChunk();
    expect(state.onFailureChange).toHaveBeenLastCalledWith(true);
    expect(state.onLoaded).not.toHaveBeenCalled();
    state.allowChunk();
    const before = { ...state.calls };
    await state.recovery.retryChunk();
    expect(state.onLoaded).toHaveBeenCalledWith('drawer');
    expect(state.importModule).toHaveBeenCalledTimes(3);
    expect(state.calls).toEqual(before);
    expect(state.detail.getCurrentResult().error).toBe(state.failure);
  } finally {
    state.dispose();
  }
});

test('analysis retry refetches only detail and exposes its failure through Query without rejecting', async () => {
  const state = await fixture();
  try {
    const before = { ...state.calls };
    await expect(state.recovery.retryAnalysis()).resolves.toBeUndefined();
    expect(state.calls).toEqual({ ...before, detail: before.detail + 1 });
    expect(state.detail.getCurrentResult().error).toBe(state.failure);
    expect(state.vcs.getCurrentResult().error).toBe(state.failure);
    state.allowDetail();
    await state.recovery.retryAnalysis();
    expect(state.detail.getCurrentResult().data).toBe('detail available');
  } finally {
    state.dispose();
  }
});

test('a failing optional VCS query cannot block drawer render-region recovery', async () => {
  const state = await fixture();
  try {
    state.allowDetail();
    const reset = mock(() => undefined);
    const before = { ...state.calls };
    await recoverRegion(reset, state.recovery.recoverRegion);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual({ ...before, detail: before.detail + 1 });
    expect(state.vcs.getCurrentResult().error).toBe(state.failure);
  } finally {
    state.dispose();
  }
});

test('a failed owning detail query leaves the render region unavailable for another explicit retry', async () => {
  const state = await fixture();
  try {
    const reset = mock(() => undefined);
    await expect(recoverRegion(reset, state.recovery.recoverRegion)).rejects.toBe(state.failure);
    expect(reset).not.toHaveBeenCalled();
    expect(state.detail.getCurrentResult().error).toBe(state.failure);
  } finally {
    state.dispose();
  }
});

test('a disabled detail observer can recover without calling the sentinel transport', async () => {
  const client = createWebQueryClient();
  const transport = mock(() => Promise.reject(new ORPCError('Unavailable')));
  const adapter: SessionClientAdapter = {
    campaignChildren: transport,
    detail: transport,
    lookup: transport,
    neighbors: transport,
    page: transport,
    vcs: transport,
  };
  const options = optionalSessionDetailQueryOptions(adapter, undefined, { browser: true });
  const detail = new QueryObserver(client, options);
  const stop = detail.subscribe(() => undefined);
  const drawer = createLazyModuleLoader({
    importModule: () => Promise.resolve('drawer'),
    onFailureChange: () => undefined,
    onLoaded: () => undefined,
  });
  const recovery = createSessionDetailRecovery(detail, drawer, () => false);
  const reset = mock(() => undefined);
  try {
    expect(options.enabled).toBe(false);
    await expect(recoverRegion(reset, recovery.recoverRegion)).resolves.toBeUndefined();
    expect(reset).toHaveBeenCalledTimes(1);
    await recovery.retryAnalysis();
    expect(transport).not.toHaveBeenCalled();
    expect(detail.getCurrentResult().error).toBeNull();
  } finally {
    stop();
    client.clear();
  }
});
