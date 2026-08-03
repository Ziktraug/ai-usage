import { afterAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { compile } from 'svelte/compiler';
import { createServer } from 'vite';
import type {
  ServedReportRefreshOutcome,
  ServedReportSession,
  ServedRevisionDescriptor,
} from '../../../../served-report-session';
import type { ServedReportSessionOwner } from './served-report-session-owner.svelte';

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
};

interface OwnerModule {
  createServedReportSessionOwner<Destination, Descriptor extends ServedRevisionDescriptor>(
    session: ServedReportSession<Destination, Descriptor>,
  ): ServedReportSessionOwner<Destination, Descriptor>;
}

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
const ownerModule = (await viteServer.ssrLoadModule(
  '/apps/web/src/lib/features/report/lifecycle/served-report-session-owner.svelte.ts',
)) as OwnerModule;
afterAll(async () => viteServer.close());

const descriptor = (revision: string): ServedRevisionDescriptor => ({
  captureFingerprint: `capture-${revision}`,
  revision,
});

describe('ServedReportSession rune owner', () => {
  it('publishes pending state, retains the descriptor, and exposes refresh failure', async () => {
    const initial = deferred<ServedReportRefreshOutcome>();
    const failed = deferred<ServedReportRefreshOutcome>();
    const outcomes = [initial, failed];
    const session: ServedReportSession<string> = {
      abort: () => undefined,
      refresh: () => outcomes.shift()?.promise ?? Promise.resolve({ status: 'superseded' }),
    };
    const owner = ownerModule.createServedReportSessionOwner(session);

    const firstRefresh = owner.refresh('overview');
    expect(owner.snapshot).toEqual({ pending: true, refreshError: null });
    initial.resolve({ descriptor: descriptor('revision-a'), status: 'committed' });
    await firstRefresh;
    expect(owner.snapshot).toEqual({ descriptor: descriptor('revision-a'), pending: false, refreshError: null });

    const failedRefresh = owner.refresh('breakdown');
    expect(owner.snapshot).toEqual({ descriptor: descriptor('revision-a'), pending: true, refreshError: null });
    failed.resolve({ error: new Error('refresh failed'), status: 'failed-preserving-previous' });
    await failedRefresh;
    expect(owner.snapshot).toEqual({
      descriptor: descriptor('revision-a'),
      pending: false,
      refreshError: 'refresh failed',
    });
  });

  it('does not let a superseded completion clear the newer pending refresh', async () => {
    const older = deferred<ServedReportRefreshOutcome>();
    const newer = deferred<ServedReportRefreshOutcome>();
    const outcomes = [older, newer];
    const session: ServedReportSession<string> = {
      abort: () => undefined,
      refresh: () => outcomes.shift()?.promise ?? Promise.resolve({ status: 'superseded' }),
    };
    const owner = ownerModule.createServedReportSessionOwner(session);

    const olderRefresh = owner.refresh('overview');
    const newerRefresh = owner.refresh('breakdown');
    older.resolve({ status: 'superseded' });
    await olderRefresh;
    expect(owner.snapshot.pending).toBe(true);

    newer.resolve({ descriptor: descriptor('revision-b'), status: 'committed' });
    await newerRefresh;
    expect(owner.snapshot).toEqual({ descriptor: descriptor('revision-b'), pending: false, refreshError: null });
  });

  it('delegates abort and performs idempotent disposal cleanup', async () => {
    let abortCount = 0;
    let refreshCount = 0;
    const session: ServedReportSession<string> = {
      abort: () => {
        abortCount += 1;
      },
      refresh: () => {
        refreshCount += 1;
        return Promise.resolve({ descriptor: descriptor('revision-a'), status: 'committed' });
      },
    };
    const owner = ownerModule.createServedReportSessionOwner(session);

    await owner.refresh('overview');
    owner.abort();
    expect(abortCount).toBe(1);
    expect(owner.snapshot.pending).toBe(false);

    owner.dispose();
    owner.dispose();
    expect(abortCount).toBe(2);
    expect(await owner.refresh('breakdown')).toEqual({ status: 'superseded' });
    expect(refreshCount).toBe(1);
  });

  it('compiles an explicit onDestroy consumer that disposes the owner', async () => {
    const sourcePath = new URL('./report-lifecycle-owner.svelte', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    const compiled = compile(source, { filename: sourcePath.pathname, generate: 'server', runes: true });
    expect(compiled.warnings).toEqual([]);
    expect(source).toContain('onDestroy(() => owner.dispose())');
  });
});
