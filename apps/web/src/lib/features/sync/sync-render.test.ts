import { afterAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { SyncFleet } from '@ai-usage/web-contract/sync';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { loadSyncPageData } from './sync-load';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown, label: string): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error(`${label} did not expose a Svelte component.`);
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const fleet: SyncFleet = {
  currentMachine: { id: 'machine-a', label: 'Laptop' },
  machines: [
    {
      hasLocalObservedRows: true,
      hasPortableRows: true,
      id: 'machine-a',
      label: 'Laptop',
      lastSeenAt: '2026-08-03T08:00:00.000Z',
      newestSessionAt: '2026-08-03T07:00:00.000Z',
      sessionCount: 7,
    },
  ],
  omittedMachines: 0,
  skipped: 0,
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../', import.meta.url));
const environmentFixture = fileURLToPath(new URL('./sync-ssr-environment.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: { alias: { '$app/environment': environmentFixture }, conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);
const [rootModule, progressModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sync/sync-root.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/sync/manual-transfer-progress.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const syncRoot = componentFrom(rootModule, 'Sync root fixture');
const transferProgress = componentFrom(progressModule, 'Manual transfer progress');
const { render } = rendererFrom(serverModule);

describe('Sync rendered SSR parity', () => {
  it('renders meaningful SyncRoot fleet HTML from the awaited dehydrated query without a second acquisition', async () => {
    let fleetCalls = 0;
    const data = await loadSyncPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Sync fixture owns this acquisition.')),
        url: new URL('http://sync.invalid/sync'),
      },
      {
        createClient: () => ({
          fleet: () => {
            fleetCalls += 1;
            return Promise.resolve(fleet);
          },
        }),
        now: () => Date.parse('2026-08-03T09:00:00.000Z'),
      },
    );

    const { body } = render(syncRoot, { props: { data } });
    expect(fleetCalls).toBe(1);
    expect(body).toContain('data-route-shell="sync"');
    expect(body).toContain('<h1');
    expect(body).toContain('Sync');
    expect(body).toContain('Laptop');
    expect(body).toContain('7');
    expect(body).toContain('Manual transfer');
    expect(body).not.toContain('Loading machine fleet');
  });

  it('renders accessible byte progress and processing elapsed time', () => {
    const uploading = render(transferProgress, {
      props: {
        now: 12_000,
        operation: 'preview',
        progress: { fileName: 'peer.json', fileSize: 100, loaded: 25, phase: 'uploading', total: 100 },
      },
    }).body;
    expect(uploading).not.toContain('<progress');
    expect(uploading).toContain('role="progressbar"');
    expect(uploading).toContain('aria-label="Manual import upload progress"');
    expect(uploading).toContain('aria-valuenow="25"');
    expect(uploading).toContain('style="width: 25%;"');
    expect(uploading).toContain('Uploading 25 B / 100 B');
    expect(uploading).toContain('>25%</span>');

    const processing = render(transferProgress, {
      props: {
        now: 12_000,
        operation: 'confirm',
        progress: { fileName: 'peer.json', fileSize: 100, phase: 'processing', startedAt: 7000 },
      },
    }).body;
    expect(processing).not.toContain('<progress');
    expect(processing).toContain('role="progressbar"');
    expect(processing).toContain('aria-label="Manual import processing"');
    expect(processing).not.toContain('aria-valuenow');
    expect(processing).toContain('Merging into the local database…');
    expect(processing).toContain('>5s</span>');
    expect(processing).toContain('Large files take a moment while each usage row is written and deduplicated.');

    const previewing = render(transferProgress, {
      props: {
        now: 12_000,
        operation: 'preview',
        progress: { fileName: 'peer.json', fileSize: 100, phase: 'processing', startedAt: 7000 },
      },
    }).body;
    expect(previewing).not.toContain('Merging into the local database…');
    expect(previewing).not.toContain('each usage row is written');
    expect(previewing).toContain('Checking the file against your usage…');
    expect(previewing).toContain('Nothing is written until you confirm.');
  });
});
