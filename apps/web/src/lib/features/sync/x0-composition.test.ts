import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readWorkspaceFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)), 'utf8');

describe('X0 Sync route composition', () => {
  test('awaits one Sync fleet load and renders one context-connected Sync root', () => {
    const load = readWorkspaceFile('svelte-shadow/routes/sync/+page.server.ts');
    const page = readWorkspaceFile('svelte-shadow/routes/sync/+page.svelte');

    expect(load).toContain("import { loadSyncPageData } from '$lib/features/sync/sync-load'");
    expect(load).toContain("await loadSyncPageData({ fetch, requestOwner: 'sync-root-ssr', url })");
    expect(page).toContain("import { useSourceControl } from '$lib/features/sources/context.svelte'");
    expect(page).toContain("import SyncRoot from '$lib/features/sync/sync-root.svelte'");
    expect(page).toContain('const sourceControl = useSourceControl()');
    expect(page).toContain('sourceControl.state().connection');
    expect(page.match(/<SyncRoot\b/g)).toHaveLength(1);
    expect(page).toContain('<SyncRoot {connection} {data} />');
    expect(page).not.toContain('RouteFrame');
    expect(page).not.toContain('WebQueryProvider');
  });

  test('creates thin manual-merge leaves with per-request mode and no deep imports', () => {
    const download = readWorkspaceFile('svelte-shadow/routes/api/manual-merge/download/+server.ts');
    const upload = readWorkspaceFile('svelte-shadow/routes/api/manual-merge/upload/+server.ts');

    expect(download).toContain('handleManualMergeDownloadEndpoint');
    expect(download).toContain('export const POST: RequestHandler');
    expect(download).toContain("request, locals.runtimeMode ?? 'live'");
    expect(upload).toContain('handleManualMergeUploadEndpoint');
    expect(upload).toContain('export const POST: RequestHandler');
    expect(upload).toContain("request, locals.runtimeMode ?? 'live'");
    for (const source of [download, upload]) {
      expect(source).not.toContain("import('../../../server/rpc/sync')");
      expect(source).not.toContain('sync-data.server');
      expect(source).not.toContain('sync-upload.server');
    }
  });

  test('initializes and disposes one observability owner while preserving hook seams', () => {
    const hook = readWorkspaceFile('svelte-shadow/hooks.server.ts');
    const initialization = hook.indexOf(
      'const observabilityInitialization = webReadObservabilityLifecycle.initialize()',
    );
    const handle = hook.indexOf('export const handle: Handle');
    const awaited = hook.indexOf('await observabilityInitialization', handle);
    const rpc = hook.indexOf("event.url.pathname === '/rpc'", handle);

    expect(hook).toContain(
      "import { webReadObservabilityLifecycle } from '$lib/server/observability/web-read-lifecycle.server'",
    );
    expect(initialization).toBeGreaterThan(-1);
    expect(initialization).toBeLessThan(handle);
    expect(awaited).toBeGreaterThan(handle);
    expect(awaited).toBeLessThan(rpc);
    expect(hook).toContain("process.once('sveltekit:shutdown', async () => {");
    expect(hook).toContain('await webReadObservabilityLifecycle.dispose()');
    expect(hook).not.toContain('setTimeout(() => process.exit(0)');
    expect(hook).toContain(
      "import { normalizeOwnedRpcSubrequest } from '$lib/server/rpc/subrequest-normalization.server'",
    );
    expect(hook).toContain('const rpcRequest = normalizeOwnedRpcSubrequest({');
    expect(hook).toContain('isSubRequest: event.isSubRequest');
    expect(hook).toContain('request: event.request');
    expect(hook).toContain('url: event.url');
    expect(hook).toContain("filterSerializedResponseHeaders: (name) => name === 'content-type'");
  });
});
