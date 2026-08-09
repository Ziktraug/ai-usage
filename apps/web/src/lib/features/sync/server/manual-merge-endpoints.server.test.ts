import { describe, expect, it } from 'bun:test';
import {
  handleManualMergeDownloadEndpoint,
  handleManualMergeUploadEndpoint,
  type ManualMergeEndpointDependencies,
} from './manual-merge-endpoints.server';

const request = (path: string, signal?: AbortSignal): Request =>
  new Request(`http://localhost${path}`, {
    headers: { host: 'localhost', origin: 'http://localhost' },
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

describe('SvelteKit manual merge endpoint adapter', () => {
  it('enforces the frozen request policy before acquiring a deep handler', async () => {
    let loads = 0;
    const dependencies: ManualMergeEndpointDependencies = {
      enforce: () => Promise.resolve(new Response('blocked', { status: 403 })),
      loadUpload: () => {
        loads += 1;
        return Promise.resolve(() => Promise.resolve(new Response('unreachable')));
      },
    };
    const response = await handleManualMergeUploadEndpoint(request('/api/manual-merge/upload'), 'live', dependencies);

    expect(response.status).toBe(403);
    expect(loads).toBe(0);
  });

  it('passes the original request and AbortSignal unchanged to each deep owner', async () => {
    const abort = new AbortController();
    const downloadRequest = request('/api/manual-merge/download', abort.signal);
    const uploadRequest = request('/api/manual-merge/upload', abort.signal);
    const observed: Request[] = [];
    const handler: ExplicitHandler = (value) => {
      observed.push(value);
      return Promise.resolve(new Response('accepted'));
    };
    const dependencies: ManualMergeEndpointDependencies = {
      enforce: (_request, _path, runtimeMode) => {
        expect(runtimeMode).toBe('live');
        return Promise.resolve(null);
      },
      loadDownload: () => Promise.resolve(handler),
      loadUpload: () => Promise.resolve(handler),
    };

    expect(await (await handleManualMergeDownloadEndpoint(downloadRequest, 'live', dependencies)).text()).toBe(
      'accepted',
    );
    expect(await (await handleManualMergeUploadEndpoint(uploadRequest, 'live', dependencies)).text()).toBe('accepted');
    expect(observed).toEqual([downloadRequest, uploadRequest]);
    expect(observed.every((value) => value.signal === abort.signal)).toBe(true);
  });

  it('rejects demo mode before loading the dynamic upload handler', async () => {
    let loads = 0;
    const response = await handleManualMergeUploadEndpoint(request('/api/manual-merge/upload'), 'demo', {
      loadUpload: () => {
        loads += 1;
        return Promise.resolve(() => Promise.resolve(new Response('unreachable')));
      },
    });

    expect(response.status).toBe(404);
    expect(loads).toBe(0);
  });
});

type ExplicitHandler = (request: Request) => Promise<Response>;
