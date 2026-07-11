import { describe, expect, test } from 'bun:test';
import { handleManualMergeUpload } from './manual-merge-upload.server';

const jsonRequest = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'localhost',
      origin: 'http://localhost',
      ...headers,
    },
    body,
  });

describe('manual merge upload boundary', () => {
  test('accepts a bounded same-origin JSON upload', async () => {
    let importedText = '';
    const response = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      importBundle: (text) => {
        importedText = text;
        return Promise.resolve({ ok: true as const, data: { rows: 0 } });
      },
    });

    expect(response.status).toBe(200);
    expect(importedText).toBe('{"rows":[]}');
    expect(await response.json()).toEqual({ ok: true, data: { rows: 0 } });
  });

  test('rejects cross-origin and non-JSON requests before import', async () => {
    let imports = 0;
    const importBundle = () => {
      imports += 1;
      return Promise.resolve({ ok: true as const, data: {} });
    };
    const crossOrigin = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { origin: 'http://attacker.example' }),
      { importBundle },
    );
    const wrongContentType = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { 'content-type': 'text/plain' }),
      { importBundle },
    );

    expect(crossOrigin.status).toBe(403);
    expect(wrongContentType.status).toBe(415);
    expect(imports).toBe(0);
  });

  test('rejects DNS-rebinding requests even when Host and Origin agree', async () => {
    let imports = 0;
    const response = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', {
        host: 'attacker.example',
        origin: 'http://attacker.example',
        'sec-fetch-site': 'same-origin',
      }),
      {
        importBundle: () => {
          imports += 1;
          return Promise.resolve({ ok: true as const, data: {} });
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { tag: 'UntrustedHost' }, ok: false });
    expect(imports).toBe(0);
  });

  test('enforces streamed byte and parsed row limits', async () => {
    const importBundle = () => Promise.resolve({ ok: true as const, data: {} });
    const tooManyBytes = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      importBundle,
      maxBytes: 4,
    });
    const tooManyRows = await handleManualMergeUpload(jsonRequest('{"rows":[{},{},{}]}'), {
      importBundle,
      maxRows: 2,
    });

    expect(tooManyBytes.status).toBe(413);
    expect(await tooManyBytes.json()).toMatchObject({ error: { tag: 'UploadTooLarge' }, ok: false });
    expect(tooManyRows.status).toBe(413);
    expect(await tooManyRows.json()).toMatchObject({ error: { tag: 'TooManyRows' }, ok: false });
  });

  test('returns explicit 4xx responses for malformed and invalid bundles', async () => {
    const malformed = await handleManualMergeUpload(jsonRequest('{nope'), {
      importBundle: () => Promise.resolve({ ok: true as const, data: {} }),
    });
    const invalidBundle = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      importBundle: () =>
        Promise.resolve({
          ok: false as const,
          error: { tag: 'UsageMergeError', message: 'Invalid bundle schema.', reason: 'invalid-input' },
        }),
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { tag: 'MalformedJson' }, ok: false });
    expect(invalidBundle.status).toBe(422);
    expect(await invalidBundle.json()).toEqual({
      ok: false,
      error: { tag: 'UsageMergeError', message: 'Invalid bundle schema.', reason: 'invalid-input' },
    });
  });
});
