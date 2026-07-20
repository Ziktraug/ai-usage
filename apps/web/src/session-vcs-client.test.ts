import { describe, expect, test } from 'bun:test';
import { loadSessionVcsResolution } from './session-vcs-client';

const request = { revision: 'revision-a', rowId: 'row-a' };
const FORBIDDEN_BROWSER_AUTHORITY = /machine|branch|repository|remote|sourceSession|path/i;

describe('session VCS client', () => {
  test('sends only exact revision and row identity and does not cache results', async () => {
    const requests: unknown[] = [];
    const source = {
      resolve: (input: unknown) => {
        requests.push(input);
        return Promise.resolve({
          pullRequests: [],
          repositoryUrl: 'https://github.com/fixture/project',
          status: 'available',
        });
      },
    };
    await loadSessionVcsResolution(request, source);
    await loadSessionVcsResolution(request, source);
    expect(requests).toEqual([request, request]);
    expect(JSON.stringify(requests)).not.toMatch(FORBIDDEN_BROWSER_AUTHORITY);
  });

  test('deduplicates only a pending explicit request and separates changed rows', async () => {
    const requests: unknown[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = {
      resolve: async (input: unknown) => {
        requests.push(input);
        await gate;
        return { reason: 'not-found', status: 'unavailable' };
      },
    };
    const first = loadSessionVcsResolution(request, source);
    const duplicate = loadSessionVcsResolution(request, source);
    const changed = loadSessionVcsResolution({ ...request, rowId: 'row-b' }, source);
    expect(requests).toEqual([request, { ...request, rowId: 'row-b' }]);
    release?.();
    expect(await first).toEqual({ reason: 'not-found', status: 'unavailable' });
    expect(await duplicate).toEqual({ reason: 'not-found', status: 'unavailable' });
    await changed;
  });

  test('rejects malformed and dangerous resolver responses', async () => {
    await expect(
      loadSessionVcsResolution(request, {
        resolve: () =>
          Promise.resolve({
            pullRequests: [],
            repositoryUrl: 'javascript:private',
            status: 'available',
          }),
      }),
    ).rejects.toThrow();
  });
});
