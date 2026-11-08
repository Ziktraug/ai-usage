import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const URL_READ_PATTERN = /\burl\b/;
const URL_REFERENCES_PATTERN = /\burl\b/g;
const FETCH_CALL_PATTERN = /\bfetch\s*\(/;

describe('report route load invalidation', () => {
  test('keeps layout navigation reactive while report acquisition ignores search changes', async () => {
    const layoutSource = await readFile(new URL('../+layout.ts', import.meta.url), 'utf8');
    const pageSource = await readFile(new URL('+layout.ts', import.meta.url), 'utf8');

    expect(layoutSource).toContain('({ data }) => data');
    expect(layoutSource).not.toContain('createWebQuery');
    expect(layoutSource).not.toContain('untrack');
    expect(layoutSource).not.toContain('searchParams');
    expect(pageSource).toContain('await untrack(() => parent())');
    // Intent warming may read a detached URL, but must not make search navigation load-scoped.
    expect(pageSource).toContain('untrack(() => new URL(url.href))');
    expect(pageSource.match(URL_REFERENCES_PATTERN)).toHaveLength(2); // parameter and the sole untracked read
    expect(pageSource).not.toContain('searchParams');
    expect(pageSource).not.toMatch(FETCH_CALL_PATTERN);
    expect(pageSource).toContain('prefetchNavigationIntent(data.reportQueryState,');
  });

  test('acquires the report on the server so hydration never repeats the request', async () => {
    const pageSource = await readFile(new URL('+layout.ts', import.meta.url), 'utf8');
    const serverSource = await readFile(new URL('+layout.server.ts', import.meta.url), 'utf8');

    // Hydration must never call the SSR acquisition path or create another runtime.
    expect(pageSource).not.toContain('acquireLiveReportQueryState');
    expect(pageSource).not.toContain('createWebQueryRuntime');
    expect(serverSource).toContain('acquireLiveReportQueryState');
    expect(serverSource).toContain('if (isDataRequest)');
    expect(serverSource).toContain('deferredLiveReportQueryState()');
    expect(serverSource).toContain("depends('ai-usage:report-root')");
    // Serialised server data is what the hydrating client adopts.
    expect(pageSource).toContain('data.reportQueryState');
  });

  test('keeps the server load document-scoped so filters and ranges stay client-side', async () => {
    const serverSource = await readFile(new URL('+layout.server.ts', import.meta.url), 'utf8');

    // A tracked url read makes the load search-scoped: every filter or range change would refetch
    // __data.json and re-acquire the report the mounted component already owns.
    expect(serverSource).toContain('untrack(() => new URL(url.href))');
    // Acquisition calls the router in process: no RPC base URL, no subrequest (ADR 0076).
    expect(serverSource).toContain('createInProcessWebRpcClient(request)');
    expect(serverSource).not.toContain('fetch(request)');
    expect(serverSource).not.toContain('requestOwner');
    expect(serverSource).not.toContain('pageUrl: url');
    expect(serverSource).not.toContain('searchParams');
  });

  test('keeps root quota prefetch document-scoped so report search stays local', async () => {
    const layoutServerSource = await readFile(new URL('../+layout.server.ts', import.meta.url), 'utf8');

    expect(layoutServerSource).toContain('if (isDataRequest');
    expect(layoutServerSource).toContain('quotaQueryState: emptyQueryState');
    expect(layoutServerSource).toContain('createInProcessWebRpcClient(request)');
    expect(layoutServerSource).not.toMatch(URL_READ_PATTERN);
    expect(layoutServerSource).not.toContain('searchParams');
  });
});
