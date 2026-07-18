import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const EVENT_LOOP_PROBE_BUDGET_MS = 1250;
const REPRESENTATIVE_SESSION_COUNT = 64;
const SKILLS_BUSINESS_DATA_MARKER = 'data-known-project-paths-status="ok"';
const SKILLS_SHELL_MARKER = 'Skill management';
const RUNNER_FAILURE_PATTERN =
  /Invalid ai-usage workspace root|Unable to discover the ai-usage workspace|ENOENT[^\n]*revision-query-runner|revisionQueryRunner failed/;
const SOURCE_CONTROL_STARTED_MARKER = '[ai-usage] Source control started.';
const SOURCE_CONTROL_STOPPED_MARKER = '[ai-usage] Source control stopped.';

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

const readInitialSourceControlSnapshot = (port: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          host: `localhost:${port}`,
          origin: `http://localhost:${port}`,
          'sec-fetch-site': 'same-origin',
        },
        host: LOOPBACK_HOST,
        path: '/api/source-control',
        port,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Source-control SSE returned status ${response.statusCode ?? 0}.`));
          return;
        }
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          if (Buffer.byteLength(text) > LOG_LIMIT_BYTES) {
            request.destroy(new Error('Source-control SSE initial event exceeded its limit.'));
            return;
          }
          const data = text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (!data) {
            return;
          }
          request.destroy();
          try {
            const parsed = JSON.parse(data) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              reject(new Error('Source-control SSE snapshot must be an object.'));
              return;
            }
            resolve(parsed as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Source-control SSE exceeded its ${REQUEST_TIMEOUT_MS}ms deadline.`));
    });
    request.once('error', (error) => {
      if (error.message !== 'The operation was aborted.') {
        reject(error);
      }
    });
    request.end();
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

const seedRepresentativeHistory = async (home: string): Promise<void> => {
  const sessionsDirectory = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  await mkdir(sessionsDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: REPRESENTATIVE_SESSION_COUNT }, (_, index) => {
      const sessionId = `production-smoke-${index}`;
      const content = `${JSON.stringify({
        payload: { cwd: `/work/project-${index % 8}`, id: sessionId },
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
      })}\n${JSON.stringify({
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: index,
              input_tokens: index + 10,
              output_tokens: index + 20,
              total_tokens: index * 2 + 30,
            },
          },
          type: 'token_count',
        },
        timestamp: '2026-01-01T00:01:00.000Z',
      })}\n`;
      return writeFile(path.join(sessionsDirectory, `${sessionId}.jsonl`), content);
    }),
  );
};

export interface OwnedProcessDeadlines {
  forceExitMs: number;
  gracefulShutdownMs: number;
  logDrainMs: number;
}

export interface OwnedProcessResult {
  stderr: string;
  stdout: string;
}

const defaultOwnedProcessDeadlines: OwnedProcessDeadlines = {
  forceExitMs: FORCE_EXIT_DEADLINE_MS,
  gracefulShutdownMs: GRACEFUL_SHUTDOWN_DEADLINE_MS,
  logDrainMs: LOG_DRAIN_DEADLINE_MS,
};

const stopChild = async (child: Bun.Subprocess, deadlines: OwnedProcessDeadlines): Promise<void> => {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await within(
    'graceful shutdown',
    deadlines.gracefulShutdownMs,
    Promise.race([child.exited, Bun.sleep(deadlines.gracefulShutdownMs)]),
  );
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await within('forced shutdown', deadlines.forceExitMs, child.exited);
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

export const withOwnedProcess = async (
  options: {
    command: string[];
    cwd: string;
    deadlines?: OwnedProcessDeadlines;
    env: Record<string, string>;
    port: number;
  },
  verify: (child: Bun.Subprocess, logs: OwnedProcessResult) => Promise<void>,
): Promise<OwnedProcessResult> => {
  const deadlines = options.deadlines ?? defaultOwnedProcessDeadlines;
  const child = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = captureLogs(child.stdout);
  const stderr = captureLogs(child.stderr);
  const logs = { stderr: '', stdout: '' };
  try {
    await verify(child, logs);
    return logs;
  } finally {
    await stopChild(child, deadlines);
    await Promise.all([
      within('stdout drain', deadlines.logDrainMs, stdout.done),
      within('stderr drain', deadlines.logDrainMs, stderr.done),
    ]);
    logs.stdout = stdout.text();
    logs.stderr = stderr.text();
    await assertPortReusable(options.port);
  }
};

const rootDir = path.resolve(import.meta.dir, '..');
const runProductionSmoke = async (): Promise<void> => {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-web-smoke-'));
  try {
    await seedRepresentativeHistory(temporaryHome);
    const port = await reserveFreePort();
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== 'AI_USAGE_ROOT_DIR'),
    );
    const childEnv: Record<string, string> = {
      ...inheritedEnv,
      HOME: temporaryHome,
      AI_USAGE_PRODUCTION_SMOKE: '1',
      HOST: '0.0.0.0',
      NITRO_HOST: '0.0.0.0',
      NITRO_PORT: String(port),
      PORT: String(port),
    };
    let processLogs: OwnedProcessResult | undefined;
    try {
      processLogs = await withOwnedProcess(
        {
          command: ['bun', 'start.mjs'],
          cwd: path.join(rootDir, 'apps/web'),
          env: childEnv,
          port,
        },
        async (child, logs) =>
          await within(
            'production smoke',
            OVERALL_DEADLINE_MS,
            (async () => {
              await waitForApplicationPage(port, child, '/', 'Usage report');
              const sourceSnapshot = await readInitialSourceControlSnapshot(port);
              const serializedSourceSnapshot = JSON.stringify(sourceSnapshot);
              if (
                !Array.isArray(sourceSnapshot.sources) ||
                serializedSourceSnapshot.includes(temporaryHome) ||
                serializedSourceSnapshot.includes('/work/project-')
              ) {
                throw new Error('Source-control SSE did not return a sanitized bounded snapshot.');
              }
              const commandResponse = await sendHttpRequest(port, {
                body: '{"command":"detect-all"}',
                headers: {
                  'content-type': 'application/json',
                  host: `localhost:${port}`,
                  origin: `http://localhost:${port}`,
                  'sec-fetch-site': 'same-origin',
                },
                method: 'POST',
                path: '/api/source-control/command',
              });
              if (commandResponse.status !== 200 || !commandResponse.body.includes('"ok":true')) {
                throw new Error(`Source-control command route did not converge (status ${commandResponse.status}).`);
              }
              const probeStartedAt = performance.now();
              const probe = await sendHttpRequest(port, { path: '/' });
              const probeDurationMs = performance.now() - probeStartedAt;
              if (probe.status !== 200 || probeDurationMs > EVENT_LOOP_PROBE_BUDGET_MS) {
                throw new Error(
                  `Production event-loop probe took ${probeDurationMs.toFixed(0)}ms with status ${probe.status}; budget is ${EVENT_LOOP_PROBE_BUDGET_MS}ms.`,
                );
              }
              const skills = await waitForApplicationPage(port, child, '/skills', SKILLS_SHELL_MARKER);
              if (skills.body.includes(SKILLS_BUSINESS_DATA_MARKER)) {
                throw new Error('/skills embedded business data in its initial HTML.');
              }

              const localHost = `localhost:${port}`;
              await requireRejected(
                'hostile Host on a read route',
                sendHttpRequest(port, { headers: { host: 'attacker.example' } }),
              );
              await requireRejected(
                'hostile Host on the source-control stream',
                sendHttpRequest(port, {
                  headers: { host: 'attacker.example' },
                  path: '/api/source-control',
                }),
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
              await requireRejected(
                'cross-site metadata on a source-control command',
                sendHttpRequest(port, {
                  body: '{"command":"detect-all"}',
                  headers: {
                    'content-type': 'application/json',
                    host: localHost,
                    origin: `http://${localHost}`,
                    'sec-fetch-site': 'cross-site',
                  },
                  method: 'POST',
                  path: '/api/source-control/command',
                }),
              );
              await requireNonLoopbackConnectionFailure(nonLoopbackIpv4Address(), port);

              if (child.exitCode !== null) {
                throw new Error(`Web process exited after production checks (code ${child.exitCode}).`);
              }
              if (RUNNER_FAILURE_PATTERN.test(`${logs.stdout}${logs.stderr}`)) {
                throw new Error('Production logs contain a report runner or workspace path resolution failure.');
              }
              process.stdout.write(
                'Production web routes are healthy, trusted-local only, and bound to IPv4 loopback.\n',
              );
            })(),
          ),
      );
      if (!processLogs.stderr.includes(SOURCE_CONTROL_STARTED_MARKER)) {
        throw new Error('Production source control did not finish startup before shutdown.');
      }
      if (!processLogs.stderr.includes(SOURCE_CONTROL_STOPPED_MARKER)) {
        throw new Error('Production source control did not run its scoped close hook.');
      }
    } catch (error) {
      const logs = `${processLogs?.stdout ?? ''}${processLogs?.stderr ?? ''}`.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\n${logs}` : ''}`);
    }
  } finally {
    await rm(temporaryHome, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  await runProductionSmoke();
}
