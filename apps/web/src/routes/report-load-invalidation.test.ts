import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const routeLoadSources = ['+layout.ts', '+page.ts'] as const;

describe('report route load invalidation', () => {
  test('captures only the RPC origin so filter and sort search navigation cannot reacquire the bootstrap', async () => {
    for (const routeLoadSource of routeLoadSources) {
      const source = await readFile(new URL(routeLoadSource, import.meta.url), 'utf8');
      expect(source).toContain('untrack(() => new URL(url.origin))');
      expect(source).toContain('url: rpcBaseUrl');
      expect(source).not.toContain('searchParams');
    }
  });
});
