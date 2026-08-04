import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('report route load invalidation', () => {
  test('keeps layout navigation reactive while report acquisition ignores search changes', async () => {
    const layoutSource = await readFile(new URL('+layout.ts', import.meta.url), 'utf8');
    const pageSource = await readFile(new URL('+page.ts', import.meta.url), 'utf8');

    expect(layoutSource).toContain('createWebQueryLoadState({ fetch, url })');
    expect(layoutSource).not.toContain('untrack');
    expect(layoutSource).not.toContain('searchParams');
    expect(pageSource).toContain('untrack(() => new URL(url.origin))');
    expect(pageSource).toContain('await untrack(() => parent())');
    expect(pageSource).toContain('url: rpcBaseUrl');
    expect(pageSource).not.toContain('searchParams');
  });
});
