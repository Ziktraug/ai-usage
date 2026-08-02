import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
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
const MINIMUM_SSE_HOLD_MS = 30_000;
const SSE_CLIENT_GRACE_MS = 3000;
const SHUTDOWN_DEADLINE_MS = 5000;
const LIFECYCLE_OVERHEAD_MS = 5000;

export const svelteKitRuntimeLifecycleBudget = {
  minimumSseHoldMs: MINIMUM_SSE_HOLD_MS,
  readinessMs: READY_DEADLINE_MS,
  shutdownMs: SHUTDOWN_DEADLINE_MS,
  sseClientGraceMs: SSE_CLIENT_GRACE_MS,
  totalMs: READY_DEADLINE_MS + MINIMUM_SSE_HOLD_MS + SSE_CLIENT_GRACE_MS + SHUTDOWN_DEADLINE_MS + LIFECYCLE_OVERHEAD_MS,
} as const;

export interface SvelteKitRuntimeLifecycleOptions {
  readonly artifactDirectory: string;
  readonly command: (port: number) => readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly minimumSseHoldMs?: number;
  readonly ssrMarker: string;
  readonly temporaryBaseDirectory?: string;
}

export interface SvelteKitRuntimeLifecycleResult {
  readonly heldForMs: number;
  readonly pid: number;
  readonly port: number;
  readonly startTimeTicks: string;
}

export interface ArtifactFileSnapshot {
  readonly digest: string | undefined;
  readonly linkTarget: string | undefined;
  readonly relativePath: string;
  readonly stat: Stats;
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const digestFile = async (filePath: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

export const snapshotArtifactFiles = async (root: string, relativePath = ''): Promise<ArtifactFileSnapshot[]> => {
  const absolutePath = path.join(root, relativePath);
  const stat = await lstat(absolutePath);
  const entries: ArtifactFileSnapshot[] = [
    {
      digest: stat.isFile() ? await digestFile(absolutePath) : undefined,
      linkTarget: stat.isSymbolicLink() ? await readlink(absolutePath) : undefined,
      relativePath,
      stat,
    },
  ];
  if (stat.isDirectory()) {
    for (const child of await readdir(absolutePath)) {
      const childEntries = await snapshotArtifactFiles(root, path.join(relativePath, child));
      for (const childEntry of childEntries) {
        entries.push(childEntry);
      }
    }
  }
  return entries;
};

export const assertArtifactSnapshotUnchanged = async (
  root: string,
  before: readonly ArtifactFileSnapshot[],
): Promise<void> => {
  const after = await snapshotArtifactFiles(root);
  assert(after.length === before.length, 'Runtime changed the artifact file set.');
  for (const entry of before) {
    const currentEntry = after.find(({ relativePath }) => relativePath === entry.relativePath);
    assert(currentEntry, `Runtime removed artifact path ${entry.relativePath}.`);
    const metadataUnchanged =
      sameFileIdentity(entry.stat, currentEntry.stat) &&
      entry.stat.mode === currentEntry.stat.mode &&
      entry.stat.nlink === currentEntry.stat.nlink &&
      entry.stat.size === currentEntry.stat.size &&
      entry.stat.mtimeMs === currentEntry.stat.mtimeMs;
    assert(
      metadataUnchanged && entry.digest === currentEntry.digest && entry.linkTarget === currentEntry.linkTarget,
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

const stopOwnedChild = async (child: Bun.Subprocess): Promise<void> => {
  signalProcessGroup(child.pid, 'SIGTERM');
  let shutdownError: unknown;
  try {
    const exitCode = await waitForExit(child);
    assert(exitCode === 0, `Runtime exited with code ${exitCode}.`);
  } catch (error) {
    shutdownError = error;
  }
  if (processGroupIsAlive(child.pid)) {
    signalProcessGroup(child.pid, 'SIGKILL');
    await child.exited;
  }
  assert(!(processIsAlive(child.pid) || processGroupIsAlive(child.pid)), 'Runtime survived shutdown.');
  if (shutdownError !== undefined) {
    throw shutdownError;
  }
};

const checkSse = async (
  origin: string,
  root: string,
  minimumHoldMs: number,
  environment: Readonly<Record<string, string>>,
): Promise<number> => {
  const bodyPath = path.join(root, 'logs', 'sse-body.txt');
  const stderrPath = path.join(root, 'logs', 'sse-stderr.txt');
  const timeoutSeconds = Math.ceil((minimumHoldMs + SSE_CLIENT_GRACE_MS) / 1000);
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

const combineErrors = (primary: unknown, cleanup: unknown): unknown => {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError([primary, cleanup], 'Runtime verification and cleanup failed.');
  }
  return primary ?? cleanup;
};

export const checkSvelteKitRuntimeLifecycle = async (
  options: SvelteKitRuntimeLifecycleOptions,
): Promise<SvelteKitRuntimeLifecycleResult> => {
  const minimumSseHoldMs = options.minimumSseHoldMs ?? MINIMUM_SSE_HOLD_MS;
  assert(
    Number.isSafeInteger(minimumSseHoldMs) && minimumSseHoldMs >= MINIMUM_SSE_HOLD_MS,
    'SSE proof must hold for at least 30 seconds.',
  );
  const temporaryBaseDirectory = options.temporaryBaseDirectory ?? os.tmpdir();
  const root = await mkdtemp(path.join(temporaryBaseDirectory, 'ai-usage-sveltekit-runtime-'));
  let artifactSnapshot: ArtifactFileSnapshot[] | undefined;
  let child: Bun.Subprocess | undefined;
  let cleanupError: unknown;
  let heldForMs = 0;
  let port: number | undefined;
  let primaryError: unknown;
  let startTimeTicks: string | undefined;

  try {
    try {
      await chmod(root, 0o700);
      for (const directory of ['cache', 'config', 'data', 'home', 'logs', 'store', 'tmp']) {
        await mkdir(path.join(root, directory));
      }
      artifactSnapshot = await snapshotArtifactFiles(options.artifactDirectory);
      port = await reservePort();
      const origin = `http://${LOOPBACK_HOST}:${port}`;
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
      child = Bun.spawn([...options.command(port)], {
        cwd: options.artifactDirectory,
        detached: process.platform !== 'win32',
        env: { ...isolatedEnvironment, ORIGIN: origin },
        stderr: Bun.file(path.join(root, 'logs', 'stderr.txt')),
        stdout: Bun.file(path.join(root, 'logs', 'stdout.txt')),
      });
      const observedStartTimeTicks = await readProcessStartTimeTicks(child.pid);
      assert(observedStartTimeTicks !== null && processIsAlive(child.pid), 'Runtime identity was not observable.');
      startTimeTicks = observedStartTimeTicks;
      await waitForReady(origin, child);
      const response = await fetch(origin);
      const html = await response.text();
      assert(response.status === 200 && html.includes(options.ssrMarker), 'SSR marker was absent.');
      const asset = await fetch(`${origin}/runtime-asset.txt`);
      assert((await asset.text()).trim() === 'sveltekit-runtime-asset-ok', 'Static asset failed.');
      heldForMs = await checkSse(origin, root, minimumSseHoldMs, isolatedEnvironment);
    } catch (error) {
      primaryError = error;
    }

    try {
      if (child !== undefined) {
        await stopOwnedChild(child);
      }
      if (port !== undefined) {
        await assertPortReleased(port);
      }
      if (artifactSnapshot !== undefined) {
        await assertArtifactSnapshotUnchanged(options.artifactDirectory, artifactSnapshot);
      }
    } catch (error) {
      cleanupError = error;
    }
  } finally {
    try {
      if (child !== undefined && processGroupIsAlive(child.pid)) {
        signalProcessGroup(child.pid, 'SIGKILL');
        await child.exited;
      }
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error);
    }
    try {
      await rm(root, { force: true, recursive: true });
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error);
    }
  }

  const error = combineErrors(primaryError, cleanupError);
  if (error !== undefined) {
    throw error;
  }
  assert(child !== undefined && port !== undefined && startTimeTicks !== undefined, 'Runtime result was incomplete.');
  return { heldForMs, pid: child.pid, port, startTimeTicks };
};
