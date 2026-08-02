import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  errorHasCode,
  processIsAlive,
  readProcessStartTimeTicks,
  sameFileIdentity,
} from '@ai-usage/usage-engine-control/node';

const LOOPBACK_HOST = '127.0.0.1';
const READY_DEADLINE_MS = 10_000;
const SHUTDOWN_DEADLINE_MS = 5000;

export interface SvelteKitRuntimeLifecycleOptions {
  readonly artifactDirectory: string;
  readonly command: (port: number) => readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly minimumSseHoldMs?: number;
  readonly ssrMarker: string;
}

export interface SvelteKitRuntimeLifecycleResult {
  readonly heldForMs: number;
  readonly pid: number;
  readonly port: number;
  readonly startTimeTicks: string;
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

interface FileSnapshot {
  readonly relativePath: string;
  readonly stat: Stats;
}

const snapshotFiles = async (root: string, relativePath = ''): Promise<FileSnapshot[]> => {
  const absolutePath = path.join(root, relativePath);
  const stat = await lstat(absolutePath);
  const entries = [{ relativePath, stat }];
  if (stat.isDirectory()) {
    for (const child of await readdir(absolutePath)) {
      entries.push(...(await snapshotFiles(root, path.join(relativePath, child))));
    }
  }
  return entries;
};

const assertSnapshotUnchanged = async (root: string, before: readonly FileSnapshot[]): Promise<void> => {
  const after = await snapshotFiles(root);
  assert(after.length === before.length, 'Runtime changed the artifact file set.');
  for (const entry of before) {
    const currentEntry = after.find(({ relativePath }) => relativePath === entry.relativePath);
    assert(currentEntry, `Runtime removed artifact path ${entry.relativePath}.`);
    assert(
      sameFileIdentity(entry.stat, currentEntry.stat) && entry.stat.size === currentEntry.stat.size,
      `Runtime rewrote artifact path ${entry.relativePath}.`,
    );
  }
};

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve an ephemeral loopback port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const assertPortReleased = async (port: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
};

const processGroupIsAlive = (processGroupId: number): boolean => {
  try {
    process.kill(process.platform === 'win32' ? processGroupId : -processGroupId, 0);
    return true;
  } catch (error) {
    if (errorHasCode(error, 'ESRCH')) {
      return false;
    }
    throw error;
  }
};

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(process.platform === 'win32' ? processGroupId : -processGroupId, signal);
  } catch (error) {
    if (!errorHasCode(error, 'ESRCH')) {
      throw error;
    }
  }
};

const waitForReady = async (origin: string, child: Bun.Subprocess): Promise<void> => {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `Runtime exited before readiness (${child.exitCode}).`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The bounded loop reports one stable error below.
    }
    await Bun.sleep(25);
  }
  throw new Error('Runtime did not become ready on numeric loopback.');
};

const waitForExit = async (child: Bun.Subprocess): Promise<number> => {
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  while (child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  if (child.exitCode === null) {
    signalProcessGroup(child.pid, 'SIGKILL');
    await child.exited;
    throw new Error('Runtime required forced shutdown.');
  }
  return await child.exited;
};

const checkSse = async (
  origin: string,
  root: string,
  minimumHoldMs: number,
  environment: Readonly<Record<string, string>>,
): Promise<number> => {
  const bodyPath = path.join(root, 'logs', 'sse-body.txt');
  const stderrPath = path.join(root, 'logs', 'sse-stderr.txt');
  const timeoutSeconds = Math.ceil((minimumHoldMs + 3000) / 1000);
  const startedAt = performance.now();
  const curl = Bun.spawn(
    [
      'curl',
      '--disable',
      '--no-buffer',
      '--silent',
      '--show-error',
      '--max-time',
      String(timeoutSeconds),
      '--output',
      bodyPath,
      '--stderr',
      stderrPath,
      `${origin}/api/events`,
    ],
    { env: environment, stderr: 'ignore', stdout: 'ignore' },
  );
  const exitCode = await curl.exited;
  const heldForMs = performance.now() - startedAt;
  const [body, stderr] = await Promise.all([readFile(bodyPath, 'utf8'), readFile(stderrPath, 'utf8')]);
  assert(exitCode === 0 || exitCode === 28, `SSE curl exited ${exitCode}: ${stderr}`);
  assert(body.includes('event: ready'), 'SSE ready event was absent.');
  assert(body.includes('event: held'), 'SSE held event was absent.');
  assert(heldForMs >= minimumHoldMs, `SSE held for only ${heldForMs.toFixed(1)}ms.`);
  return heldForMs;
};

export const checkSvelteKitRuntimeLifecycle = async (
  options: SvelteKitRuntimeLifecycleOptions,
): Promise<SvelteKitRuntimeLifecycleResult> => {
  const minimumSseHoldMs = options.minimumSseHoldMs ?? 30_000;
  assert(
    Number.isSafeInteger(minimumSseHoldMs) && minimumSseHoldMs >= 30_000,
    'SSE proof must hold for at least 30 seconds.',
  );
  const artifactSnapshot = await snapshotFiles(options.artifactDirectory);
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-sveltekit-runtime-'));
  await chmod(root, 0o700);
  for (const directory of ['cache', 'config', 'data', 'home', 'logs', 'store', 'tmp']) {
    await mkdir(path.join(root, directory));
  }
  const port = await reservePort();
  const isolatedEnvironment = {
    ...(options.environment ?? {}),
    HOME: path.join(root, 'home'),
    HOST: LOOPBACK_HOST,
    PATH: process.env.PATH ?? '',
    PORT: String(port),
    TMPDIR: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
  };
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const child = Bun.spawn([...options.command(port)], {
    cwd: options.artifactDirectory,
    detached: process.platform !== 'win32',
    env: { ...isolatedEnvironment, ORIGIN: origin },
    stderr: Bun.file(path.join(root, 'logs', 'stderr.txt')),
    stdout: Bun.file(path.join(root, 'logs', 'stdout.txt')),
  });
  const startTimeTicks = await readProcessStartTimeTicks(child.pid);
  assert(startTimeTicks !== null && processIsAlive(child.pid), 'Runtime identity was not observable.');

  let verificationError: unknown;
  let heldForMs = 0;
  try {
    await waitForReady(origin, child);
    const response = await fetch(origin);
    const html = await response.text();
    assert(response.status === 200 && html.includes(options.ssrMarker), 'SSR marker was absent.');
    const asset = await fetch(`${origin}/runtime-asset.txt`);
    assert((await asset.text()).trim() === 'sveltekit-runtime-asset-ok', 'Static asset failed.');
    heldForMs = await checkSse(origin, root, minimumSseHoldMs, isolatedEnvironment);
  } catch (error) {
    verificationError = error;
  }

  let cleanupError: unknown;
  try {
    signalProcessGroup(child.pid, 'SIGTERM');
    const exitCode = await waitForExit(child);
    assert(exitCode === 0, `Runtime exited with code ${exitCode}.`);
    assert(!(processIsAlive(child.pid) || processGroupIsAlive(child.pid)), 'Runtime survived shutdown.');
    await assertPortReleased(port);
    await assertSnapshotUnchanged(options.artifactDirectory, artifactSnapshot);
  } catch (error) {
    cleanupError = error;
  } finally {
    if (processGroupIsAlive(child.pid)) {
      signalProcessGroup(child.pid, 'SIGKILL');
      await child.exited;
    }
    await rm(root, { force: true, recursive: true });
  }
  if (verificationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([verificationError, cleanupError], 'Runtime verification and cleanup failed.');
  }
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  return { heldForMs, pid: child.pid, port, startTimeTicks };
};
