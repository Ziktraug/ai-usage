import { describe, expect, it } from 'bun:test';
import { parseUsageEngineMergePreviewOutput } from '@ai-usage/usage-engine-control';
import {
  createManualTransferClient,
  type ManualUploadProgress,
  type ManualUploadRequest,
} from './manual-transfer-client';

const preview = parseUsageEngineMergePreviewOutput({
  bundle: { generatedAt: '2026-07-30T12:00:00.000Z', machineId: 'machine-b', machineLabel: 'Peer MacBook' },
  bytes: 2,
  confirmationToken: `v1.${'b'.repeat(64)}`,
  documentDigest: 'a'.repeat(64),
  kind: 'merge-preview',
  result: {
    deleted: 0,
    fleetChanged: true,
    inserted: 1,
    superseded: 0,
    unchanged: 0,
    updated: 0,
    warnings: 1,
  },
  rows: 1,
  warningCount: 1,
  warningItems: ['One row was skipped.'],
});

describe('manual transfer browser client', () => {
  it('previews and confirms the same bounded file with opaque preconditions and signal', async () => {
    const calls: ManualUploadRequest[] = [];
    const progress: ManualUploadProgress[] = [];
    const abort = new AbortController();
    const client = createManualTransferClient(undefined, (request) => {
      calls.push(request);
      const { action, file, onProgress } = request;
      onProgress?.({
        fileName: file.name,
        fileSize: file.size,
        loaded: file.size,
        phase: 'uploading',
        total: file.size,
      });
      onProgress?.({ fileName: file.name, fileSize: file.size, phase: 'processing', startedAt: 12 });
      return Promise.resolve(Response.json({ data: action === 'preview' ? preview : { kind: 'none' }, ok: true }));
    });
    const file = new File(['{}'], 'peer.json', { type: 'application/json' });

    const previewed = await client.preview(file, abort.signal, (value) => progress.push(value));
    expect(previewed).toEqual({ data: preview, ok: true });
    // Bundle identity and the warning excerpts decide whether the counters are expected or alarming,
    // so the browser boundary has to carry them, not just the proof and the totals.
    expect(previewed.ok && previewed.data.bundle).toEqual({
      generatedAt: '2026-07-30T12:00:00.000Z',
      machineId: 'machine-b',
      machineLabel: 'Peer MacBook',
    });
    expect(previewed.ok && previewed.data.warningItems).toEqual(['One row was skipped.']);
    expect(await client.confirm(file, preview, abort.signal, (value) => progress.push(value))).toEqual({
      data: { kind: 'none' },
      ok: true,
    });
    expect(calls.map(({ action }) => action)).toEqual(['preview', 'confirm']);
    expect(calls.every((call) => call.file === file && call.signal === abort.signal)).toBe(true);
    expect(calls[1]?.headers['x-ai-usage-merge-confirmation']).toBe(`v1.${'b'.repeat(64)}`);
    expect(calls[1]?.headers['x-ai-usage-merge-digest']).toBe('a'.repeat(64));
    expect(progress.map(({ phase }) => phase)).toEqual([
      'uploading',
      'uploading',
      'processing',
      'uploading',
      'uploading',
      'processing',
    ]);
  });

  it('rejects empty files and malformed or unbounded public responses', async () => {
    let calls = 0;
    const noNetwork = createManualTransferClient(undefined, () => {
      calls += 1;
      return Promise.resolve(new Response());
    });
    expect((await noNetwork.preview(new File([], 'empty.json'))).ok).toBe(false);
    expect(calls).toBe(0);

    const malformed = createManualTransferClient(undefined, () =>
      Promise.resolve(
        Response.json({ error: { message: 'x'.repeat(513), tag: 'PrivateFailure' }, ok: false }, { status: 500 }),
      ),
    );
    expect(await malformed.preview(new File(['{}'], 'peer.json'))).toEqual({
      error: { message: 'The server returned an invalid response.', tag: 'InvalidResponse' },
      ok: false,
    });
  });

  it('reports the validated row count without consuming the download response', async () => {
    const document = JSON.stringify({ rows: [{ id: 1 }, { id: 2 }] });
    const client = createManualTransferClient(() =>
      Promise.resolve(
        new Response(document, {
          headers: {
            'content-disposition': 'attachment; filename="ai-usage-export.json"',
            'content-length': String(new TextEncoder().encode(document).byteLength),
            'content-type': 'application/json; charset=utf-8',
          },
        }),
      ),
    );

    const download = await client.download();
    expect(download.rows).toBe(2);
    expect(await download.response.text()).toBe(document);
  });
});
