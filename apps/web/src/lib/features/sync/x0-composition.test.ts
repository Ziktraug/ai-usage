import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readWorkspaceFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)), 'utf8');

describe('canonical Sync route composition', () => {
  test('awaits one document fleet load, defers SPA entry, and renders one context-connected Sync root', () => {
    const load = readWorkspaceFile('src/routes/sync/+page.server.ts');
    const page = readWorkspaceFile('src/routes/sync/+page.svelte');

    expect(load).toContain('deferredSyncPageData, loadSyncPageData');
    expect(load).toContain('if (isDataRequest)');
    expect(load).toContain('return deferredSyncPageData()');
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
    const download = readWorkspaceFile('src/routes/api/manual-merge/download/+server.ts');
    const upload = readWorkspaceFile('src/routes/api/manual-merge/upload/+server.ts');

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
    const hook = readWorkspaceFile('src/hooks.server.ts');
    const initialization = hook.indexOf('observabilityInitialization ??= webReadObservabilityLifecycle.initialize()');
    const handle = hook.indexOf('const handleApplicationRequest: Handle');
    const awaited = hook.indexOf('await initializeObservability()', handle);
    const resolved = hook.indexOf('const response = await resolve', handle);
    const rpcRoute = readWorkspaceFile('src/routes/rpc/[...rest]/+server.ts');

    expect(hook).toContain(
      "import { webReadObservabilityLifecycle } from '$lib/server/observability/web-read-lifecycle.server'",
    );
    expect(hook).toContain("import { handleTrustedLocalRequest } from '../src/server/trusted-local-hook.server'");
    // Compression wraps the trust seam so short-circuited responses are encoded too.
    expect(hook).toContain('sequence(handleResponseCompression, handleTrustedLocalRequest, handleApplicationRequest)');
    expect(initialization).toBeGreaterThan(-1);
    expect(initialization).toBeLessThan(handle);
    expect(awaited).toBeGreaterThan(handle);
    expect(awaited).toBeLessThan(resolved);
    expect(hook).toContain("process.once('sveltekit:shutdown', async () => {");
    expect(hook).toContain('await webReadObservabilityLifecycle.dispose()');
    expect(hook).not.toContain('setTimeout(() => process.exit(0)');
    expect(rpcRoute).toContain(
      "import { normalizeOwnedRpcSubrequest } from '$lib/server/rpc/subrequest-normalization.server'",
    );
    expect(rpcRoute).toContain('const rpcRequest = normalizeOwnedRpcSubrequest({ isSubRequest, request, url })');
    expect(rpcRoute).toContain('export const GET = handleRpcRequest');
    expect(rpcRoute).toContain('export const POST = handleRpcRequest');
    expect(hook).toContain("filterSerializedResponseHeaders: (name) => name === 'content-type'");
  });
});
