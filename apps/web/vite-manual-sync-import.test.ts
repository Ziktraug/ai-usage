import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { ManualOperationResult } from './src/manual-transfer-contract';
import { handleManualSyncImportDevRequest } from './vite-manual-sync-import';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const startDevUploadServer = async (options: {
  importBundle: (text: string) => Promise<ManualOperationResult<unknown>>;
  maxBytes: number;
}) => {
  const server = createServer((request, response) => {
    handleManualSyncImportDevRequest(request, response, options).catch(() => {
      response.writeHead(500).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected the dev upload test server to use a TCP port.');
  }
  return address.port;
};

const sendChunkedUpload = (
  port: number,
  chunks: string[],
  headers: Record<string, string>,
): Promise<{ body: string; status: number }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers,
        hostname: '127.0.0.1',
        method: 'POST',
        path: '/sync',
        port,
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => responseChunks.push(chunk));
        response.on('end', () => {
          resolve({ body: Buffer.concat(responseChunks).toString('utf8'), status: response.statusCode ?? 0 });
        });
      },
    );
    request.once('error', reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });

describe('Vite manual sync import middleware', () => {
  test('rejects hostile Host and Origin values before importing', async () => {
    let imports = 0;
    const port = await startDevUploadServer({
      importBundle: () => {
        imports += 1;
        return Promise.resolve({ ok: true as const, data: {} });
      },
      maxBytes: 1024,
    });

    const hostileHost = await sendChunkedUpload(port, ['{"rows":[]}'], {
      'content-type': 'application/json',
      host: 'attacker.example',
      origin: 'http://attacker.example',
    });
    const hostileOrigin = await sendChunkedUpload(port, ['{"rows":[]}'], {
      'content-type': 'application/json',
      host: `localhost:${port}`,
      origin: 'http://attacker.example',
    });

    expect(hostileHost.status).toBe(403);
    expect(hostileOrigin.status).toBe(403);
    expect(imports).toBe(0);
  });

  test('rejects and drains a large hostile body without importing it', async () => {
    let imports = 0;
    const port = await startDevUploadServer({
      importBundle: () => {
        imports += 1;
        return Promise.resolve({ ok: true as const, data: {} });
      },
      maxBytes: 1024,
    });
    const hostileChunks = Array.from({ length: 512 }, () => 'x'.repeat(8192));

    const response = await sendChunkedUpload(port, hostileChunks, {
      'content-type': 'application/json',
      host: 'attacker.example',
      origin: 'http://attacker.example',
    });

    expect(response.status).toBe(403);
    expect(imports).toBe(0);
  });

  test('streams chunked requests through the production byte limit', async () => {
    let imports = 0;
    const port = await startDevUploadServer({
      importBundle: () => {
        imports += 1;
        return Promise.resolve({ ok: true as const, data: {} });
      },
      maxBytes: 8,
    });

    const response = await sendChunkedUpload(port, ['{"rows":', '[]}'], {
      'content-type': 'application/json',
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: { tag: 'UploadTooLarge' }, ok: false });
    expect(imports).toBe(0);
  });
});
