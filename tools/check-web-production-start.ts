import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';

const LOOPBACK_HOST = '127.0.0.1';
const LOG_LIMIT_BYTES = 64 * 1024;
const START_DEADLINE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5000;
const GRACEFUL_SHUTDOWN_DEADLINE_MS = 3000;
const FORCE_EXIT_DEADLINE_MS = 2000;
const LOG_DRAIN_DEADLINE_MS = 2000;
const OVERALL_DEADLINE_MS = 30_000;
const PROJECT_LOADER_ERROR_MARKER = 'Could not load scanned projects:';
const PROJECT_LOADER_SUCCESS_MARKER = 'data-known-project-paths-status="ok"';
const RUNNER_FAILURE_PATTERN =
  /Invalid ai-usage workspace root|Unable to discover the ai-usage workspace|ENOENT[^\n]*report-payload-runner|reportPayloadRunner failed/;

interface HttpResponse {
  body: string;
  status: number;
}

const within = async <Value>(phase: string, deadlineMs: number, promise: Promise<Value>): Promise<Value> => {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${phase} exceeded its ${deadlineMs}ms deadline.`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const reserveFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback TCP port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const nonLoopbackIpv4Address = (): string => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        return address.address;
      }
    }
  }
  throw new Error('No non-loopback IPv4 address is available for the production listener check.');
};

const captureLogs = (stream: ReadableStream<Uint8Array>) => {
  const retained: Uint8Array[] = [];
  let retainedBytes = 0;
  const done = (async () => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      if (retainedBytes < LOG_LIMIT_BYTES) {
        const remaining = LOG_LIMIT_BYTES - retainedBytes;
        const kept = chunk.value.slice(0, remaining);
        retained.push(kept);
        retainedBytes += kept.byteLength;
      }
    }
  })();
  return {
    done,
    text: () => new TextDecoder().decode(Buffer.concat(retained.map((chunk) => Buffer.from(chunk)))),
  };
};

const sendHttpRequest = (
  port: number,
  options: {
    body?: string;
    connectHost?: string;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
  } = {},
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: options.headers,
        host: options.connectHost ?? LOOPBACK_HOST,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ body: Buffer.concat(chunks).toString('utf8'), status: response.statusCode ?? 0 });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`HTTP request exceeded its ${REQUEST_TIMEOUT_MS}ms deadline.`));
    });
    request.once('error', reject);
    request.end(options.body);
  });

const waitForApplicationPage = async (
  port: number,
  child: Bun.Subprocess,
  pathname: string,
  marker: string,
): Promise<HttpResponse> => {
  const deadline = Date.now() + START_DEADLINE_MS;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Web process exited before ${pathname} was ready (code ${child.exitCode}).`);
    }
    try {
      const response = await sendHttpRequest(port, { path: pathname });
      lastStatus = response.status;
      if (response.status === 200 && response.body.includes(marker)) {
        return response;
      }
    } catch {
      // The bounded retry loop reports a single useful failure below.
    }
    await Bun.sleep(100);
  }
  throw new Error(`${pathname} did not return its application marker before the deadline (last status ${lastStatus}).`);
};

const requireRejected = async (label: string, response: Promise<HttpResponse>): Promise<void> => {
  const result = await response;
  if (result.status < 400 || result.status >= 500) {
    throw new Error(`${label} was not rejected with a 4xx response (received ${result.status}).`);
  }
};

const requireNonLoopbackConnectionFailure = async (host: string, port: number): Promise<void> => {
  try {
    await sendHttpRequest(port, { connectHost: host });
  } catch {
    return;
  }
  throw new Error(`Production listener unexpectedly accepted a connection through ${host}:${port}.`);
};

const stopChild = async (child: Bun.Subprocess): Promise<void> => {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await within(
    'graceful shutdown',
    GRACEFUL_SHUTDOWN_DEADLINE_MS,
    Promise.race([child.exited, Bun.sleep(GRACEFUL_SHUTDOWN_DEADLINE_MS)]),
  );
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await within('forced shutdown', FORCE_EXIT_DEADLINE_MS, child.exited);
  }
};

const assertPortReusable = async (port: number): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

const rootDir = path.resolve(import.meta.dir, '..');
const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-smoke-'));
try {
  const port = await reserveFreePort();
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'AI_USAGE_ROOT_DIR'));
  const childEnv: Record<string, string> = {
    ...inheritedEnv,
    HOME: temporaryHome,
    HOST: '0.0.0.0',
    NITRO_HOST: '0.0.0.0',
    NITRO_PORT: String(port),
    PORT: String(port),
  };
  const child = Bun.spawn(['node', 'start.mjs'], {
    cwd: path.join(rootDir, 'apps/web'),
    env: childEnv,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = captureLogs(child.stdout);
  const stderr = captureLogs(child.stderr);

  try {
    await within(
      'production smoke',
      OVERALL_DEADLINE_MS,
      (async () => {
        await waitForApplicationPage(port, child, '/', 'Usage report');
        const skills = await waitForApplicationPage(port, child, '/skills', PROJECT_LOADER_SUCCESS_MARKER);
        if (skills.body.includes(PROJECT_LOADER_ERROR_MARKER)) {
          throw new Error('/skills rendered the known project-loader error banner.');
        }

        const localHost = `localhost:${port}`;
        await requireRejected(
          'hostile Host on a read route',
          sendHttpRequest(port, { headers: { host: 'attacker.example' } }),
        );
        await requireRejected(
          'hostile Origin on a read route',
          sendHttpRequest(port, { headers: { host: localHost, origin: 'http://attacker.example' } }),
        );
        await requireRejected(
          'cross-site metadata on a mutation route',
          sendHttpRequest(port, {
            body: '{}',
            headers: {
              'content-type': 'application/json',
              host: localHost,
              origin: `http://${localHost}`,
              'sec-fetch-site': 'cross-site',
            },
            method: 'POST',
            path: '/sync',
          }),
        );
        await requireNonLoopbackConnectionFailure(nonLoopbackIpv4Address(), port);

        if (child.exitCode !== null) {
          throw new Error(`Web process exited after production checks (code ${child.exitCode}).`);
        }
        const logs = `${stdout.text()}${stderr.text()}`;
        if (RUNNER_FAILURE_PATTERN.test(logs)) {
          throw new Error('Production logs contain a report runner or workspace path resolution failure.');
        }
        process.stdout.write('Production web routes are healthy, trusted-local only, and bound to IPv4 loopback.\n');
      })(),
    );
  } catch (error) {
    const logs = `${stdout.text()}${stderr.text()}`.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\n${logs}` : ''}`);
  } finally {
    await stopChild(child);
    await Promise.all([
      within('stdout drain', LOG_DRAIN_DEADLINE_MS, stdout.done),
      within('stderr drain', LOG_DRAIN_DEADLINE_MS, stderr.done),
    ]);
    await assertPortReusable(port);
  }
} finally {
  await rm(temporaryHome, { force: true, recursive: true });
}
