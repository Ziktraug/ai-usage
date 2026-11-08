import { describe, expect, it, mock, spyOn } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { browserQueryRuntime, installBrowserQueryRuntime } from '../../query/browser-runtime';
import { createWebQueryRuntime, type WebQueryRuntime } from '../../query/composition';
import { createWebRpcClient } from '../../rpc/client';
import { installReportIntentResolver, prefetchReportTabIntent } from '../report/core/report-intent';
import { NAVIGATION_PREFETCH_BUDGET_MS, prefetchNavigationIntent } from './intent-prefetch';

const emptyState = { dehydratedState: { mutations: [], queries: [] } };
const makeRuntime = () =>
  createWebQueryRuntime({
    rpc: createWebRpcClient({
      url: 'http://intent.invalid/rpc',
      fetch: () => Promise.reject(new Error('Unexpected transport')),
    }),
  });

const withBrowserRuntime = async (run: (runtime: WebQueryRuntime) => Promise<void>): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const runtime = makeRuntime();
  const uninstall = installBrowserQueryRuntime(runtime);
  try {
    await run(runtime);
  } finally {
    uninstall();
    runtime.queryClient.clear();
    if (descriptor) {
      Object.defineProperty(globalThis, 'window', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('navigation intent budget', () => {
  it('does not guess a tab destination without a mounted live resolver, or after it unmounts', async () => {
    await withBrowserRuntime(async (runtime) => {
      await prefetchReportTabIntent(new URL('http://intent.invalid/?tab=sessions'), 'live');
      const resolve = mock((_url: URL) => null);
      const unmount = installReportIntentResolver(resolve);
      try {
        await prefetchReportTabIntent(new URL('http://intent.invalid/?tab=sessions'), 'e2e');
        await prefetchReportTabIntent(new URL('http://intent.invalid/sync'), 'live');
        expect(resolve).not.toHaveBeenCalled();
        await prefetchReportTabIntent(new URL('http://intent.invalid/?tab=sessions'), 'live');
        expect(resolve).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
      await prefetchReportTabIntent(new URL('http://intent.invalid/?tab=sessions'), 'live');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(runtime.queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
  });
  it('does not acquire during hydration before the provider mounts', async () => {
    await withBrowserRuntime(async (runtime) => {
      // Model universal hydration: window exists, but the provider's onMount has not installed it.
      installBrowserQueryRuntime(runtime)();
      expect(browserQueryRuntime()).toBeUndefined();
      let calls = 0;
      await prefetchNavigationIntent(emptyState, () => {
        calls += 1;
        return Promise.resolve();
      });
      expect(calls).toBe(0);
    });
  });

  it('refuses server installation', () => {
    const runtime = makeRuntime();
    try {
      expect(() => installBrowserQueryRuntime(runtime)).toThrow('cannot be installed on the server');
    } finally {
      runtime.queryClient.clear();
    }
  });

  it('does not reacquire server-provided state and cleans up the provider registration', async () => {
    await withBrowserRuntime(async (runtime) => {
      let calls = 0;
      await runtime.queryClient.query({ queryKey: ['server'], queryFn: () => 'provided' });
      const { dehydrateWebQueryClient } = await import('../../query/client');
      await prefetchNavigationIntent(dehydrateWebQueryClient(runtime.queryClient), () => {
        calls += 1;
        return Promise.resolve();
      });
      expect(calls).toBe(0);
    });
    expect(browserQueryRuntime()).toBeUndefined();
  });

  it('releases routing after 250ms without cancelling the in-flight query', async () => {
    await withBrowserRuntime(async (runtime) => {
      let finish: (value: string) => void = () => {
        throw new Error('Query not started');
      };
      const pending = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const start = performance.now();
      await prefetchNavigationIntent(emptyState, async ({ queryClient }) => {
        await queryClient.query({ queryKey: ['slow-intent'], queryFn: () => pending });
      });
      expect(performance.now() - start).toBeGreaterThanOrEqual(NAVIGATION_PREFETCH_BUDGET_MS - 5);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(runtime.queryClient.getQueryState(['slow-intent'])?.fetchStatus).toBe('fetching');
      finish('complete');
      await pending;
      await runtime.queryClient.query({
        queryKey: ['slow-intent'],
        queryFn: () => pending,
        staleTime: Number.POSITIVE_INFINITY,
      });
      expect(runtime.queryClient.getQueryData(['slow-intent'])).toBe('complete');
    });
  });

  it('does not fail navigation, but leaves the failure visible to destination queries', async () => {
    await withBrowserRuntime(async (runtime) => {
      const failure = new ORPCError('Unavailable', { message: 'The fleet is unavailable' });
      await prefetchNavigationIntent(emptyState, async ({ queryClient }) => {
        await queryClient.query({ queryKey: ['failed-intent'], queryFn: () => Promise.reject(failure) });
      });
      expect(runtime.queryClient.getQueryState(['failed-intent'])?.status).toBe('error');
      expect(runtime.queryClient.getQueryState(['failed-intent'])?.error).toBe(failure);
    });
  });

  it('surfaces programming errors via reportError without rejecting navigation, even after its budget', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
    const report = mock((_cause: unknown) => undefined);
    Object.defineProperty(globalThis, 'reportError', { configurable: true, value: report });
    try {
      await withBrowserRuntime(async () => {
        const failure = new TypeError('Cannot read properties of undefined');
        await prefetchNavigationIntent(emptyState, () => Promise.reject(failure));
        expect(report).toHaveBeenCalledWith(failure);
        let reject: (cause: unknown) => void = () => {
          throw new Error('Prefetch did not start');
        };
        const delayed = new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
        await prefetchNavigationIntent(emptyState, () => delayed);
        reject(failure);
        await delayed.catch(() => undefined);
        await Promise.resolve();
        expect(report).toHaveBeenCalledTimes(2);
      });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'reportError', descriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'reportError');
      }
    }
  });

  it('uses console.error when reportError is unavailable, but does not report expected transport failures', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
    Reflect.deleteProperty(globalThis, 'reportError');
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await withBrowserRuntime(async () => {
        await prefetchNavigationIntent(emptyState, () => Promise.reject(new TypeError('Failed to fetch')));
        await prefetchNavigationIntent(emptyState, () => Promise.reject(new DOMException('Cancelled', 'AbortError')));
        expect(logged).not.toHaveBeenCalled();
        const defect = new Error('Invariant violated');
        await prefetchNavigationIntent(emptyState, () => Promise.reject(defect));
        expect(logged).toHaveBeenCalledWith('Unexpected navigation prefetch failure', defect);
      });
    } finally {
      logged.mockRestore();
      if (descriptor) {
        Object.defineProperty(globalThis, 'reportError', descriptor);
      }
    }
  });

  it('an old provider cleanup cannot remove its replacement', async () => {
    await withBrowserRuntime((runtime) => {
      const cleanup = installBrowserQueryRuntime(runtime);
      const replacement = makeRuntime();
      const removeReplacement = installBrowserQueryRuntime(replacement);
      cleanup();
      expect(browserQueryRuntime()).toBe(replacement);
      removeReplacement();
      replacement.queryClient.clear();
      return Promise.resolve();
    });
  });
});
