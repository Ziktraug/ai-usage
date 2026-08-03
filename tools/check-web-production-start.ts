import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';

const LOOPBACK_HOST = '127.0.0.1';
const LOG_LIMIT_BYTES = 64 * 1024;
const HTTP_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const START_DEADLINE_MS = 15_000;
const DEVELOPMENT_START_DEADLINE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;
// The production supervisor owns a 5 s graceful window followed by a 3 s
// forced-cleanup window. Its wrapper must never kill it before both complete.
const GRACEFUL_SHUTDOWN_DEADLINE_MS = 12_000;
const FORCE_EXIT_DEADLINE_MS = 2000;
const LOG_DRAIN_DEADLINE_MS = 2000;
const OVERALL_DEADLINE_MS = 30_000;
const EVENT_LOOP_PROBE_BUDGET_MS = 1250;
const REPRESENTATIVE_SESSION_COUNT = 64;
const SKILLS_BUSINESS_DATA_MARKER = 'data-known-project-paths-status="ok"';
const SKILLS_SHELL_MARKER = 'Skill management';
const RUNNER_FAILURE_PATTERN =
  /Invalid ai-usage workspace root|Unable to discover the ai-usage workspace|ENOENT[^\n]*revision-query-runner|revisionQueryRunner failed/;

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
    let completed = false;
    let deadline: Timer | undefined;
    let request: ReturnType<typeof httpRequest> | undefined;
    const finish = (result: { readonly error: unknown } | { readonly response: HttpResponse }): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (deadline) {
        clearTimeout(deadline);
      }
      request?.destroy();
      if ('error' in result) {
        reject(result.error);
      } else {
        resolve(result.response);
      }
    };
    request = httpRequest(
      {
        headers: options.headers,
        host: options.connectHost ?? LOOPBACK_HOST,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', (chunk: Buffer) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > HTTP_RESPONSE_LIMIT_BYTES) {
            finish({ error: new Error('HTTP response exceeded its bounded body limit.') });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish({
            response: { body: Buffer.concat(chunks).toString('utf8'), status: response.statusCode ?? 0 },
          });
        });
      },
    );
    deadline = setTimeout(
      () => finish({ error: new Error(`HTTP request exceeded its ${REQUEST_TIMEOUT_MS}ms deadline.`) }),
      REQUEST_TIMEOUT_MS,
    );
    request.once('error', (error) => finish({ error }));
    request.end(options.body);
  });

const readInitialSourceControlSnapshot = (port: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let completed = false;
    let deadline: Timer | undefined;
    let request: ReturnType<typeof httpRequest> | undefined;
    const finish = (result: { readonly error: unknown } | { readonly snapshot: Record<string, unknown> }): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (deadline) {
        clearTimeout(deadline);
      }
      request?.destroy();
      if ('error' in result) {
        reject(result.error);
      } else {
        resolve(result.snapshot);
      }
    };
    request = httpRequest(
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
          finish({ error: new Error(`Source-control SSE returned status ${response.statusCode ?? 0}.`) });
          return;
        }
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text = `${text}${chunk.toString('utf8')}`.replaceAll('\r\n', '\n');
          if (Buffer.byteLength(text) > LOG_LIMIT_BYTES) {
            finish({ error: new Error('Source-control SSE initial event exceeded its limit.') });
            return;
          }
          let frameBoundary = text.indexOf('\n\n');
          while (frameBoundary >= 0) {
            const frame = text.slice(0, frameBoundary);
            text = text.slice(frameBoundary + 2);
            const lines = frame.split('\n');
            if (lines.some((line) => line === 'event: snapshot')) {
              const data = lines.flatMap((line) => (line.startsWith('data: ') ? [line.slice(6)] : [])).join('\n');
              try {
                const parsed = JSON.parse(data) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                  finish({ error: new Error('Source-control SSE snapshot must be an object.') });
                  return;
                }
                finish({ snapshot: parsed as Record<string, unknown> });
              } catch (error) {
                finish({ error });
              }
              return;
            }
            frameBoundary = text.indexOf('\n\n');
          }
        });
        response.once('end', () => finish({ error: new Error('Source-control SSE ended before its snapshot.') }));
      },
    );
    deadline = setTimeout(
      () => finish({ error: new Error(`Source-control SSE exceeded its ${REQUEST_TIMEOUT_MS}ms deadline.`) }),
      REQUEST_TIMEOUT_MS,
    );
    request.once('error', (error) => finish({ error }));
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

const waitForApplicationListener = async (port: number, child: Bun.Subprocess): Promise<void> => {
  const deadline = Date.now() + DEVELOPMENT_START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Web process exited before its listener was ready (code ${child.exitCode}).`);
    }
    try {
      const response = await sendHttpRequest(port, { method: 'HEAD' });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The bounded retry loop reports one stable failure below.
    }
    await Bun.sleep(100);
  }
  throw new Error('Web listener did not answer a bounded HEAD probe before its deadline.');
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
  readonly stderr: string;
  readonly stdout: string;
}

const defaultOwnedProcessDeadlines: OwnedProcessDeadlines = {
  forceExitMs: FORCE_EXIT_DEADLINE_MS,
  gracefulShutdownMs: GRACEFUL_SHUTDOWN_DEADLINE_MS,
  logDrainMs: LOG_DRAIN_DEADLINE_MS,
};

const signalOwnedProcessGroup = (child: Bun.Subprocess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const ownedProcessGroupIsAlive = (child: Bun.Subprocess): boolean => {
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

const waitForOwnedProcessGroupExit = async (child: Bun.Subprocess, deadlineMs: number): Promise<boolean> => {
  const deadline = Date.now() + deadlineMs;
  while (ownedProcessGroupIsAlive(child) && Date.now() < deadline) {
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !ownedProcessGroupIsAlive(child);
};

const stopChild = async (
  child: Bun.Subprocess,
  deadlines: OwnedProcessDeadlines,
  gracefulSignal: NodeJS.Signals,
): Promise<void> => {
  if (ownedProcessGroupIsAlive(child)) {
    if (gracefulSignal === 'SIGINT') {
      signalOwnedProcessGroup(child, gracefulSignal);
    } else {
      child.kill(gracefulSignal);
    }
  }
  if (!(await waitForOwnedProcessGroupExit(child, deadlines.gracefulShutdownMs))) {
    signalOwnedProcessGroup(child, 'SIGKILL');
    if (!(await waitForOwnedProcessGroupExit(child, deadlines.forceExitMs))) {
      throw new Error('Owned process group survived forced shutdown.');
    }
  }
  await within('owned direct child exit', deadlines.forceExitMs, child.exited);
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
    shutdownSignal?: NodeJS.Signals;
  },
  verify: (child: Bun.Subprocess, logs: OwnedProcessResult) => Promise<void>,
): Promise<OwnedProcessResult> => {
  const deadlines = options.deadlines ?? defaultOwnedProcessDeadlines;
  const child = Bun.spawn(options.command, {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: options.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = captureLogs(child.stdout);
  const stderr = captureLogs(child.stderr);
  const logs: OwnedProcessResult = {
    get stderr() {
      return stderr.text();
    },
    get stdout() {
      return stdout.text();
    },
  };
  let verificationError: unknown;
  try {
    await verify(child, logs);
  } catch (error) {
    verificationError = error;
  }
  try {
    await stopChild(child, deadlines, options.shutdownSignal ?? 'SIGTERM');
    await Promise.all([
      within('stdout drain', deadlines.logDrainMs, stdout.done),
      within('stderr drain', deadlines.logDrainMs, stderr.done),
    ]);
    await assertPortReusable(options.port);
  } catch (cleanupError) {
    if (verificationError !== undefined) {
      throw new AggregateError([verificationError, cleanupError], 'Process verification and cleanup both failed.');
    }
    throw cleanupError;
  }
  if (verificationError !== undefined) {
    const output = `${logs.stdout}${logs.stderr}`.trim();
    const message = verificationError instanceof Error ? verificationError.message : String(verificationError);
    throw new Error(`${message}${output ? `\n${output}` : ''}`, { cause: verificationError });
  }
  return logs;
};

const rootDir = path.resolve(import.meta.dir, '..');

interface ProductionRuntimeFixture {
  readonly childEnvironment: Record<string, string>;
  readonly databasePath: string;
  readonly dispose: () => Promise<void>;
  readonly homeDirectory: string;
  readonly lockPath: string;
  readonly rendezvousPath: string;
  readonly stateDirectory: string;
}

const isolatedInheritedEnvironment = (): Record<string, string> => ({
  CI: '1',
  NO_COLOR: '1',
  PATH: process.env.PATH ?? '',
  TURBO_DAEMON: 'false',
  TURBO_TELEMETRY_DISABLED: '1',
});

const createProductionRuntimeFixture = async (
  prefix: string,
  webPort: number,
  enginePort?: number,
): Promise<ProductionRuntimeFixture> => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  const databasePath = path.join(homeDirectory, 'store', 'usage.sqlite');
  const stateDirectory = path.join(homeDirectory, 'engine-state');
  const logDirectory = path.join(homeDirectory, 'logs');
  const temporaryDirectory = path.join(homeDirectory, 'tmp');
  await Promise.all(
    [path.dirname(databasePath), stateDirectory, logDirectory, temporaryDirectory].map(
      async (directory) => await mkdir(directory, { mode: 0o700, recursive: true }),
    ),
  );
  return {
    childEnvironment: {
      ...isolatedInheritedEnvironment(),
      AI_USAGE_DATABASE_PATH: databasePath,
      ...(enginePort === undefined ? {} : { AI_USAGE_ENGINE_PORT: String(enginePort) }),
      AI_USAGE_ENGINE_STATE_DIR: stateDirectory,
      AI_USAGE_HOME: homeDirectory,
      AI_USAGE_LOG_DIR: logDirectory,
      AI_USAGE_PRODUCTION_SMOKE: '1',
      AI_USAGE_ROOT_DIR: rootDir,
      AI_USAGE_TEMP_ROOT: temporaryDirectory,
      HOME: homeDirectory,
      HOST: '0.0.0.0',
      IDLE_TIMEOUT: '45',
      PORT: String(webPort),
      TMPDIR: temporaryDirectory,
      TURBO_CACHE_DIR: path.join(homeDirectory, 'turbo-cache'),
      XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
      XDG_CONFIG_HOME: path.join(homeDirectory, '.config'),
      XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'),
    },
    databasePath,
    dispose: async () => await rm(homeDirectory, { force: true, recursive: true }),
    homeDirectory,
    lockPath: `${databasePath}.engine.lock`,
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    stateDirectory,
  };
};

const waitForRootDevelopmentEngine = async (
  fixture: ProductionRuntimeFixture,
  child: Bun.Subprocess,
): Promise<{ readonly instanceId: string; readonly port: number }> => {
  const targetId = usageEngineTargetIdFor({ configCwd: rootDir, databasePath: fixture.databasePath });
  const deadline = Date.now() + DEVELOPMENT_START_DEADLINE_MS;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Root development runtime exited before engine readiness (code ${child.exitCode}).`);
    }
    try {
      const rendezvous = await loadUsageEngineRendezvous(fixture.rendezvousPath);
      assertUsageEngineRendezvousTarget(rendezvous, targetId);
      const client = createUsageEngineControlClient({
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        resolveRendezvous: () => Promise.resolve(rendezvous),
      });
      const status = await client.getStatus();
      if (status.instanceId === rendezvous.instanceId && status.readiness === 'ready') {
        return { instanceId: status.instanceId, port: rendezvous.port };
      }
    } catch (error) {
      lastFailure = error;
    }
    await Bun.sleep(50);
  }
  const reason = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
  throw new Error(`Root development engine did not become ready: ${reason}`);
};

const runRootDevelopmentSmoke = async (): Promise<void> => {
  const webPort = await reserveFreePort();
  const fixture = await createProductionRuntimeFixture('plan052-root-development-', webPort, 0);
  let enginePort: number | undefined;
  let processLogs: OwnedProcessResult | undefined;
  try {
    await seedRepresentativeHistory(fixture.homeDirectory);
    processLogs = await withOwnedProcess(
      {
        command: ['bun', '--no-env-file', 'run', 'dev'],
        cwd: rootDir,
        env: {
          ...fixture.childEnvironment,
          HOST: LOOPBACK_HOST,
        },
        port: webPort,
        shutdownSignal: 'SIGINT',
      },
      async (child) => {
        const engine = await waitForRootDevelopmentEngine(fixture, child);
        enginePort = engine.port;
        await waitForApplicationListener(webPort, child);
        const sourceSnapshot = await readInitialSourceControlSnapshot(webPort);
        if (sourceSnapshot.instanceId !== engine.instanceId) {
          throw new Error('Root development Web and engine resolved different runtime targets.');
        }
      },
    );
    if (RUNNER_FAILURE_PATTERN.test(`${processLogs.stdout}${processLogs.stderr}`)) {
      throw new Error('Root development logs contain a retired report runner or target-path failure.');
    }
    await assertRuntimeReleased(fixture, 'Root development runtime');
    if (enginePort !== undefined) {
      await assertPortReusable(enginePort);
    }
    process.stdout.write('Root development starts one shared engine/Web target and reaps both task trees.\n');
  } catch (error) {
    const logs = `${processLogs?.stdout ?? ''}${processLogs?.stderr ?? ''}`.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\n${logs}` : ''}`);
  } finally {
    await fixture.dispose();
  }
};

const assertRuntimeReleased = async (fixture: ProductionRuntimeFixture, label: string): Promise<void> => {
  if (await Bun.file(fixture.rendezvousPath).exists()) {
    throw new Error(`${label} left its engine rendezvous after shutdown.`);
  }
  if (await Bun.file(fixture.lockPath).exists()) {
    throw new Error(`${label} left its engine writer lock after shutdown.`);
  }
};

const runHealthyProductionSmoke = async (): Promise<void> => {
  const port = await reserveFreePort();
  const fixture = await createProductionRuntimeFixture('plan052-production-smoke-', port);
  const { childEnvironment, homeDirectory, lockPath, rendezvousPath } = fixture;
  try {
    await seedRepresentativeHistory(homeDirectory);
    let processLogs: OwnedProcessResult | undefined;
    try {
      processLogs = await withOwnedProcess(
        {
          command: ['bun', '--no-env-file', 'run', 'start'],
          cwd: rootDir,
          env: childEnvironment,
          port,
        },
        async (child, logs) =>
          await within(
            'production smoke',
            OVERALL_DEADLINE_MS,
            (async () => {
              await waitForApplicationPage(port, child, '/', 'Usage report');
              if (!(await Bun.file(rendezvousPath).exists())) {
                throw new Error('Production supervisor started web without an engine rendezvous.');
              }
              if (!(await Bun.file(lockPath).exists())) {
                throw new Error('Production supervisor started web without an engine writer lock.');
              }
              const sourceSnapshot = await readInitialSourceControlSnapshot(port);
              const serializedSourceSnapshot = JSON.stringify(sourceSnapshot);
              if (
                !Array.isArray(sourceSnapshot.sources) ||
                serializedSourceSnapshot.includes(homeDirectory) ||
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
      await assertRuntimeReleased(fixture, 'Production supervisor');
    } catch (error) {
      const logs = `${processLogs?.stdout ?? ''}${processLogs?.stderr ?? ''}`.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logs ? `\n${logs}` : ''}`);
    }
  } finally {
    await fixture.dispose();
  }
};

type CollisionRole = 'engine' | 'web';

const runProductionPortCollisionSmoke = async (role: CollisionRole): Promise<void> => {
  const occupied = Bun.serve({
    fetch: () => new Response(`occupied-${role}`),
    hostname: LOOPBACK_HOST,
    port: 0,
  });
  const occupiedPort = occupied.port;
  if (occupiedPort === undefined) {
    await occupied.stop(true);
    throw new Error(`Could not occupy the production ${role} collision port.`);
  }
  const unoccupiedPort = await reserveFreePort();
  const enginePort = role === 'engine' ? occupiedPort : unoccupiedPort;
  const webPort = role === 'web' ? occupiedPort : unoccupiedPort;
  const fixture = await createProductionRuntimeFixture(`plan052-production-${role}-collision-`, webPort, enginePort);
  try {
    const logs = await withOwnedProcess(
      {
        command: ['bun', '--no-env-file', 'run', 'start'],
        cwd: rootDir,
        env: fixture.childEnvironment,
        port: unoccupiedPort,
      },
      async (child) => {
        const exitCode = await within(`${role} port collision`, OVERALL_DEADLINE_MS, child.exited);
        if (exitCode === 0) {
          throw new Error(`Production supervisor accepted an occupied ${role} port.`);
        }
      },
    );
    const expectedDiagnostic = role === 'engine' ? 'Production engine exited first' : 'Production web exited first';
    if (!`${logs.stdout}${logs.stderr}`.includes(expectedDiagnostic)) {
      throw new Error(`Production ${role} collision did not report the failing child.`);
    }
    await assertRuntimeReleased(fixture, `Production ${role} collision`);
    const ownerResponse = await sendHttpRequest(occupiedPort);
    if (ownerResponse.status !== 200 || ownerResponse.body !== `occupied-${role}`) {
      throw new Error(`Production ${role} collision disturbed the existing port owner.`);
    }
    process.stdout.write(`Production ${role} port collision failed cleanly without orphaned runtime state.\n`);
  } finally {
    await occupied.stop(true);
    await assertPortReusable(occupiedPort);
    await fixture.dispose();
  }
};

const runProductionSmoke = async (): Promise<void> => {
  await runRootDevelopmentSmoke();
  await runHealthyProductionSmoke();
  await runProductionPortCollisionSmoke('engine');
  await runProductionPortCollisionSmoke('web');
};

if (import.meta.main) {
  await runProductionSmoke();
}
