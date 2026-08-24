import { constants as FILESYSTEM_CONSTANTS } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readlink, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LOOPBACK_HOST = '127.0.0.1';
const DEV_READY_DEADLINE_MS = 60_000;
const DEV_OUTPUT_STABLE_DEADLINE_MS = 20_000;
const BUILD_DEADLINE_MS = 180_000;
/**
 * Two different waits, which used to share one 30s constant.
 *
 * The lock deadline waits for the *primary* build to reach the point where it publishes its lock.
 * That milestone is inside the build, so it cannot be given less room than the build itself: a
 * runner slow enough to need 120s for a build reaches the lock late too, and the old 30s turned
 * that into a failure of the check rather than a slow build. It shares BUILD_DEADLINE_MS for that
 * reason.
 *
 * The exit deadline is the opposite claim: a build that finds the lock must refuse and exit
 * promptly. Keeping it tight is the point -- a contending build still running after 30s means the
 * lock is not doing its job, which is exactly what this check exists to catch.
 */
const CONTENDING_BUILD_EXIT_DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;
const PROCESS_STOP_DEADLINE_MS = 3000;
const LOG_DRAIN_DEADLINE_MS = 3000;
const MAX_CAPTURED_LOG_BYTES = 128 * 1024;
const MAX_BUILD_LOCK_BYTES = 4096;
const STABILITY_SAMPLE_MS = 500;
const HMR_MESSAGE_PATTERN = /hmr update|full reload|page reload/gi;
const LIVE_PID_PATTERN = /live PID \d+/;
const WHITESPACE_PATTERN = /\s+/;

interface FileIdentity {
  dev: number;
  ino: number;
}

export type DirectoryIdentitySnapshot = ReadonlyMap<string, FileIdentity>;

interface CapturedStream {
  done: Promise<void>;
  position: () => number;
  text: () => string;
  textSince: (position: number) => string;
}

interface CapturedStreamOptions {
  maximumRetainedBytes?: number;
  maximumTotalBytes?: number;
}

interface OwnedProcess {
  child: Bun.Subprocess;
  stderr: CapturedStream;
  stdout: CapturedStream;
}

const activeOwnedProcesses = new Set<OwnedProcess>();
const activeRuntimeRoots = new Set<string>();
const rootRemovalPromises = new Map<string, Promise<void>>();
const stopPromises = new WeakMap<OwnedProcess, Promise<void>>();
let isolationInterruptRequested = false;

const assertIsolationCheckNotInterrupted = (): void => {
  if (isolationInterruptRequested) {
    throw new Error('The web build-isolation check was interrupted.');
  }
};

export interface WebBuildIsolationEnvironmentOptions {
  inheritedEnvironment: Record<string, string | undefined>;
  repositoryDirectory: string;
  runtimeRoot: string;
  useE2eAdapters: boolean;
}

export interface WebDevBuildIsolationResult {
  buildDurationMs: number;
  checkedDevOutputFiles: number;
  devPid: number;
  devProcessCountAfterBuild: number;
  devProcessCountBeforeBuild: number;
  devReadyDurationMs: number;
  healthyRequestsDuringBuild: number;
  hmrMessagesDuringBuild: number;
  mode: 'isolated' | 'legacy-observation';
  peakDeletedDevOutputDescriptors: number;
  secondBuildExitCode: number | null;
}

export interface MeasuredOperation<Value> {
  readonly durationMs: number;
  readonly value: Value;
}

export const measureOperationDuration = async <Value>(
  operation: () => Promise<Value>,
  now: () => number = performance.now.bind(performance),
): Promise<MeasuredOperation<Value>> => {
  const startedAt = now();
  const value = await operation();
  return { durationMs: now() - startedAt, value };
};

export interface WebDevBuildIsolationCheckOptions {
  beforePrimaryBuild?: (context: { devOutputDirectory: string; devPid: number }) => Promise<void>;
  mode?: 'isolated' | 'legacy-observation';
  onPrimaryBuildStarted?: (buildPid: number) => void;
  repositoryDirectory?: string;
  runtimeParentDirectory?: string;
}

const within = async <Value>(label: string, deadlineMs: number, operation: Promise<Value>): Promise<Value> => {
  let timeout: Timer | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded its ${deadlineMs}ms deadline.`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const sleepWithSignal = (durationMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', handleAbort, { once: true });
  });

const collectDirectoryIdentities = async (
  rootDirectory: string,
  currentDirectory: string,
  identities: Map<string, FileIdentity>,
): Promise<void> => {
  const directoryHandle = await open(
    currentDirectory,
    // biome-ignore lint/suspicious/noBitwiseOperators: open(2) combines independent security flags.
    FILESYSTEM_CONSTANTS.O_DIRECTORY | FILESYSTEM_CONSTANTS.O_NOFOLLOW | FILESYSTEM_CONSTANTS.O_RDONLY,
  );
  try {
    const openedDirectory = await directoryHandle.stat();
    const directoryReadPath = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : currentDirectory;
    const entries = await readdir(directoryReadPath, { withFileTypes: true });
    const currentDirectoryStats = await lstat(currentDirectory);
    if (
      !currentDirectoryStats.isDirectory() ||
      openedDirectory.dev !== currentDirectoryStats.dev ||
      openedDirectory.ino !== currentDirectoryStats.ino
    ) {
      throw new Error(`Development output directory changed while it was read: ${currentDirectory}`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await collectDirectoryIdentities(rootDirectory, entryPath, identities);
        continue;
      }
      const entryStat = await lstat(entryPath);
      identities.set(path.relative(rootDirectory, entryPath), { dev: entryStat.dev, ino: entryStat.ino });
    }
  } finally {
    await directoryHandle.close();
  }
};

export const snapshotDirectoryIdentities = async (directory: string): Promise<DirectoryIdentitySnapshot> => {
  const identities = new Map<string, FileIdentity>();
  await collectDirectoryIdentities(directory, directory, identities);
  return identities;
};

export const assertDirectoryIdentitiesPreserved = async (
  directory: string,
  expected: DirectoryIdentitySnapshot,
): Promise<{ checkedFiles: number }> => {
  const current = await snapshotDirectoryIdentities(directory);
  for (const [relativePath, identity] of expected) {
    const currentIdentity = current.get(relativePath);
    if (!currentIdentity || currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino) {
      throw new Error(`Development output was deleted or replaced during production build: ${relativePath}`);
    }
  }
  return { checkedFiles: expected.size };
};

const countPreservedDirectoryIdentities = async (
  directory: string,
  expected: DirectoryIdentitySnapshot,
): Promise<number> => {
  const current = await snapshotDirectoryIdentities(directory);
  let preserved = 0;
  for (const [relativePath, identity] of expected) {
    const currentIdentity = current.get(relativePath);
    if (currentIdentity?.dev === identity.dev && currentIdentity.ino === identity.ino) {
      preserved += 1;
    }
  }
  return preserved;
};

export const createWebBuildIsolationEnvironment = ({
  inheritedEnvironment,
  repositoryDirectory,
  runtimeRoot,
  useE2eAdapters,
}: WebBuildIsolationEnvironmentOptions): Record<string, string> => {
  const environment: Record<string, string> = {
    AI_USAGE_LOG_DIR: path.join(runtimeRoot, 'logs'),
    AI_USAGE_ROOT_DIR: repositoryDirectory,
    AI_USAGE_SVELTEKIT_PHASE: 'dev',
    BROWSER: 'none',
    CI: '1',
    HOME: path.join(runtimeRoot, 'home'),
    NO_COLOR: '1',
    PATH: inheritedEnvironment.PATH ?? '',
    TMPDIR: path.join(runtimeRoot, 'tmp'),
    TZ: 'Europe/Paris',
    VITE_AI_USAGE_DEMO: '0',
    VITE_AI_USAGE_E2E: useE2eAdapters ? '1' : '0',
    XDG_CACHE_HOME: path.join(runtimeRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(runtimeRoot, 'config'),
    XDG_DATA_HOME: path.join(runtimeRoot, 'data'),
  };
  const chromiumPath = inheritedEnvironment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (chromiumPath) {
    environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = chromiumPath;
  }
  return environment;
};

export const captureBoundedStream = (
  stream: ReadableStream<Uint8Array>,
  options: CapturedStreamOptions = {},
): CapturedStream => {
  const maximumRetainedBytes = options.maximumRetainedBytes ?? MAX_CAPTURED_LOG_BYTES;
  let retained = Buffer.alloc(0);
  let totalBytes = 0;
  const done = (async () => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      totalBytes += chunk.value.byteLength;
      if (options.maximumTotalBytes !== undefined && totalBytes > options.maximumTotalBytes) {
        await reader.cancel();
        throw new Error(`Captured process output exceeded its ${options.maximumTotalBytes}-byte budget.`);
      }
      retained = Buffer.concat([retained, Buffer.from(chunk.value)]);
      if (retained.byteLength > maximumRetainedBytes) {
        retained = retained.subarray(retained.byteLength - maximumRetainedBytes);
      }
    }
  })();
  return {
    done,
    position: () => totalBytes,
    text: () => new TextDecoder().decode(retained),
    textSince: (position) => {
      const retainedStart = totalBytes - retained.byteLength;
      if (!(Number.isSafeInteger(position) && position >= retainedStart && position <= totalBytes)) {
        throw new Error('Requested process log interval exceeded the bounded capture window.');
      }
      return new TextDecoder().decode(retained.subarray(position - retainedStart));
    },
  };
};

const spawnOwnedProcess = (
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
): OwnedProcess => {
  if (isolationInterruptRequested) {
    throw new Error('Isolation-check interruption prevents starting another child process.');
  }
  const child = Bun.spawn([...command], {
    cwd,
    detached: true,
    env: environment,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const ownedProcess = {
    child,
    stderr: captureBoundedStream(child.stderr),
    stdout: captureBoundedStream(child.stdout),
  };
  activeOwnedProcesses.add(ownedProcess);
  return ownedProcess;
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals | 0): void => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const processGroupIsAlive = (pid: number): boolean => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

const stopOwnedProcessOnce = async (ownedProcess: OwnedProcess): Promise<void> => {
  try {
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      signalProcessGroup(ownedProcess.child.pid, 'SIGTERM');
    }
    const gracefulDeadline = Date.now() + PROCESS_STOP_DEADLINE_MS;
    while (processGroupIsAlive(ownedProcess.child.pid) && Date.now() < gracefulDeadline) {
      await Bun.sleep(25);
    }
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      signalProcessGroup(ownedProcess.child.pid, 'SIGKILL');
    }
    await within('owned root process exit', PROCESS_STOP_DEADLINE_MS, ownedProcess.child.exited);
    const forcedDeadline = Date.now() + PROCESS_STOP_DEADLINE_MS;
    while (processGroupIsAlive(ownedProcess.child.pid) && Date.now() < forcedDeadline) {
      await Bun.sleep(25);
    }
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      throw new Error(`Owned process group ${ownedProcess.child.pid} survived SIGKILL.`);
    }
    await Promise.all([
      within('stdout drain', LOG_DRAIN_DEADLINE_MS, ownedProcess.stdout.done),
      within('stderr drain', LOG_DRAIN_DEADLINE_MS, ownedProcess.stderr.done),
    ]);
  } finally {
    activeOwnedProcesses.delete(ownedProcess);
  }
};

const stopOwnedProcess = (ownedProcess: OwnedProcess): Promise<void> => {
  const existing = stopPromises.get(ownedProcess);
  if (existing) {
    return existing;
  }
  const stopping = stopOwnedProcessOnce(ownedProcess);
  stopPromises.set(ownedProcess, stopping);
  return stopping;
};

const removeOwnedRuntimeRootOnce = async (runtimeRoot: string): Promise<void> => {
  const runtimeStat = await lstat(runtimeRoot);
  const currentUserId = process.getuid?.();
  if (
    !(path.basename(runtimeRoot).startsWith('plan052-web-build-isolation-') && runtimeStat.isDirectory()) ||
    runtimeStat.isSymbolicLink() ||
    (currentUserId !== undefined && runtimeStat.uid !== currentUserId)
  ) {
    throw new Error('Refusing to remove an invalid isolation-check root.');
  }
  await rm(runtimeRoot, { force: true, recursive: true });
};

const removeOwnedRuntimeRoot = (runtimeRoot: string): Promise<void> => {
  const existing = rootRemovalPromises.get(runtimeRoot);
  if (existing) {
    return existing;
  }
  const removing = removeOwnedRuntimeRootOnce(runtimeRoot).finally(() => {
    activeRuntimeRoots.delete(runtimeRoot);
  });
  rootRemovalPromises.set(runtimeRoot, removing);
  return removing;
};

export const interruptActiveWebBuildIsolationChecks = async (): Promise<void> => {
  isolationInterruptRequested = true;
  const processResults = await Promise.allSettled([...activeOwnedProcesses].map(stopOwnedProcess));
  const processFailures = processResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (processFailures.length > 0) {
    throw new AggregateError(processFailures, 'Interrupted web build-isolation process cleanup failed.');
  }
  const rootResults = await Promise.allSettled([...activeRuntimeRoots].map(removeOwnedRuntimeRoot));
  const rootFailures = rootResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (rootFailures.length > 0) {
    throw new AggregateError(rootFailures, 'Interrupted web build-isolation root cleanup failed.');
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
        reject(new Error('Unable to reserve a numeric-loopback port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const requestApplication = async (port: number, signal?: AbortSignal): Promise<boolean> => {
  try {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}/`, {
      signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
    });
    const body = await response.text();
    return response.status === 200 && body.includes('Usage report');
  } catch {
    return false;
  }
};

const waitForApplication = async (port: number, devProcess: OwnedProcess): Promise<void> => {
  const deadline = Date.now() + DEV_READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertIsolationCheckNotInterrupted();
    if (devProcess.child.exitCode !== null) {
      throw new Error(
        `Development server exited before readiness.\n${devProcess.stdout.text()}\n${devProcess.stderr.text()}`,
      );
    }
    if (await requestApplication(port)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error('Development server did not become ready before its deadline.');
};

const snapshotsAreEqual = (left: DirectoryIdentitySnapshot, right: DirectoryIdentitySnapshot): boolean => {
  if (left.size !== right.size) {
    return false;
  }
  for (const [relativePath, identity] of left) {
    const other = right.get(relativePath);
    if (!other || identity.dev !== other.dev || identity.ino !== other.ino) {
      return false;
    }
  }
  return true;
};

const waitForStableDevOutput = async (devOutputDirectory: string): Promise<DirectoryIdentitySnapshot> => {
  const deadline = Date.now() + DEV_OUTPUT_STABLE_DEADLINE_MS;
  let previous: DirectoryIdentitySnapshot | undefined;
  while (Date.now() < deadline) {
    assertIsolationCheckNotInterrupted();
    try {
      const current = await snapshotDirectoryIdentities(devOutputDirectory);
      if (current.size > 0 && previous && snapshotsAreEqual(previous, current)) {
        return current;
      }
      previous = current;
    } catch {
      previous = undefined;
    }
    await Bun.sleep(STABILITY_SAMPLE_MS);
  }
  throw new Error('Development output did not become non-empty and stable before its deadline.');
};

const readChildPids = async (pid: number): Promise<number[]> => {
  try {
    const children = await Bun.file(`/proc/${pid}/task/${pid}/children`).text();
    return children
      .trim()
      .split(WHITESPACE_PATTERN)
      .filter(Boolean)
      .map(Number)
      .filter((childPid) => Number.isSafeInteger(childPid) && childPid > 0);
  } catch {
    return [];
  }
};

const listProcessTree = async (rootPid: number): Promise<number[]> => {
  const discovered = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) {
      continue;
    }
    for (const childPid of await readChildPids(pid)) {
      if (!discovered.has(childPid)) {
        discovered.add(childPid);
        queue.push(childPid);
      }
    }
  }
  return [...discovered].sort((left, right) => left - right);
};

const countDeletedDevOutputDescriptors = async (
  pids: readonly number[],
  devOutputDirectory: string,
): Promise<number> => {
  let count = 0;
  for (const pid of pids) {
    let descriptors: string[];
    try {
      descriptors = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${descriptor}`);
        if (target.startsWith(devOutputDirectory) && target.endsWith(' (deleted)')) {
          count += 1;
        }
      } catch {
        // Descriptors may close between listing and inspection.
      }
    }
  }
  return count;
};

const waitForBuildLock = async (lockPath: string, buildProcess: OwnedProcess): Promise<void> => {
  const deadline = Date.now() + BUILD_DEADLINE_MS;
  while (Date.now() < deadline) {
    assertIsolationCheckNotInterrupted();
    if (buildProcess.child.exitCode !== null) {
      throw new Error(`Primary build exited before publishing its lock.\n${buildProcess.stderr.text()}`);
    }
    try {
      // biome-ignore lint/suspicious/noBitwiseOperators: open(2) combines independent security flags.
      const lockHandle = await open(lockPath, FILESYSTEM_CONSTANTS.O_NOFOLLOW | FILESYSTEM_CONSTANTS.O_RDONLY);
      let lockText: string;
      try {
        const lockStat = await lockHandle.stat();
        const currentUserId = process.getuid?.();
        if (
          !lockStat.isFile() ||
          lockStat.nlink !== 1 ||
          lockStat.size > MAX_BUILD_LOCK_BYTES ||
          lockStat.mode % 0o100 !== 0 ||
          (currentUserId !== undefined && lockStat.uid !== currentUserId)
        ) {
          throw new Error('Production build lock metadata is suspicious.');
        }
        lockText = await lockHandle.readFile({ encoding: 'utf8' });
      } finally {
        await lockHandle.close();
      }
      const metadata = JSON.parse(lockText) as unknown;
      if (typeof metadata === 'object' && metadata !== null && 'pid' in metadata) {
        return;
      }
    } catch {
      // The bounded poll waits until the owner has synced complete metadata.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Primary build did not publish its lock before the deadline: ${lockPath}`);
};

const runRequiredCommand = async (
  label: string,
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
): Promise<void> => {
  const ownedProcess = spawnOwnedProcess(command, cwd, environment);
  try {
    const exitCode = await within(label, BUILD_DEADLINE_MS, ownedProcess.child.exited);
    if (exitCode !== 0) {
      throw new Error(
        `${label} failed with exit code ${exitCode}.\n${ownedProcess.stdout.text()}\n${ownedProcess.stderr.text()}`,
      );
    }
  } finally {
    await stopOwnedProcess(ownedProcess);
  }
};

const pollHealthyDuringBuild = async (
  port: number,
  buildProcess: OwnedProcess,
  devPid: number,
  devOutputDirectory: string,
  signal: AbortSignal,
): Promise<{ healthyRequests: number; peakDeletedDescriptors: number }> => {
  let healthyRequests = 0;
  let peakDeletedDescriptors = 0;
  while (buildProcess.child.exitCode === null) {
    assertIsolationCheckNotInterrupted();
    signal.throwIfAborted();
    if (!(await requestApplication(port, signal))) {
      throw new Error('Development endpoint became unhealthy during production build.');
    }
    healthyRequests += 1;
    const devProcessTree = await listProcessTree(devPid);
    peakDeletedDescriptors = Math.max(
      peakDeletedDescriptors,
      await countDeletedDevOutputDescriptors(devProcessTree, devOutputDirectory),
    );
    await sleepWithSignal(250, signal);
  }
  return { healthyRequests, peakDeletedDescriptors };
};

export const runWebDevBuildIsolationCheck = async (
  options: WebDevBuildIsolationCheckOptions = {},
): Promise<WebDevBuildIsolationResult> => {
  if (process.platform !== 'linux') {
    throw new Error('The dev/build descriptor regression requires Linux /proc.');
  }
  const repositoryDirectory = options.repositoryDirectory ?? path.resolve(import.meta.dirname, '..');
  const webDirectory = path.join(repositoryDirectory, 'apps', 'web');
  const mode = options.mode ?? 'isolated';
  const devOutputDirectory = path.join(webDirectory, '.svelte-kit', 'dev');
  const buildLockPath = path.join(webDirectory, '.output-build', 'build.lock');
  const runtimeRoot = await mkdtemp(
    path.join(options.runtimeParentDirectory ?? tmpdir(), 'plan052-web-build-isolation-'),
  );
  activeRuntimeRoots.add(runtimeRoot);
  const commonEnvironment = createWebBuildIsolationEnvironment({
    inheritedEnvironment: process.env,
    repositoryDirectory,
    runtimeRoot,
    useE2eAdapters: true,
  });
  const productionEnvironment = { ...commonEnvironment, VITE_AI_USAGE_E2E: '0' };
  let buildHealthPromise: ReturnType<typeof pollHealthyDuringBuild> | undefined;
  let buildHealthRawPromise: ReturnType<typeof pollHealthyDuringBuild> | undefined;
  const buildHealthAbortController = new AbortController();
  let devProcess: OwnedProcess | undefined;
  let primaryBuild: OwnedProcess | undefined;
  let secondBuild: OwnedProcess | undefined;
  let operationError: unknown;
  let operationResult: WebDevBuildIsolationResult | undefined;

  try {
    await Promise.all(
      ['home', 'tmp', 'cache', 'config', 'data', 'logs'].map((directory) =>
        mkdir(path.join(runtimeRoot, directory), { recursive: true }),
      ),
    );
    await runRequiredCommand(
      'design-system preparation',
      ['bun', '--no-env-file', '--filter', '@ai-usage/design-system', 'build'],
      repositoryDirectory,
      commonEnvironment,
    );
    await runRequiredCommand(
      'web development preparation',
      ['bun', '--no-env-file', 'run', 'dev:prepare'],
      webDirectory,
      commonEnvironment,
    );

    const port = await reserveFreePort();
    const devReadiness = await measureOperationDuration(async () => {
      const process = spawnOwnedProcess(
        ['bun', '--no-env-file', '--bun', 'vite', '--host', LOOPBACK_HOST, '--port', String(port), '--strictPort'],
        webDirectory,
        commonEnvironment,
      );
      devProcess = process;
      await waitForApplication(port, process);
      return process;
    });
    devProcess = devReadiness.value;
    const devOutputBefore = await waitForStableDevOutput(devOutputDirectory);
    const devProcessTreeBefore = await listProcessTree(devProcess.child.pid);
    const deletedBefore = await countDeletedDevOutputDescriptors(devProcessTreeBefore, devOutputDirectory);
    if (deletedBefore !== 0) {
      throw new Error(`Development process started with ${deletedBefore} deleted dev-output descriptors.`);
    }
    const devStdoutPositionBeforeBuild = devProcess.stdout.position();
    const devStderrPositionBeforeBuild = devProcess.stderr.position();

    await options.beforePrimaryBuild?.({ devOutputDirectory, devPid: devProcess.child.pid });
    const buildStartedAt = performance.now();
    primaryBuild = spawnOwnedProcess(
      ['bun', '--no-env-file', 'run', '--cwd', 'apps/web', 'build'],
      repositoryDirectory,
      productionEnvironment,
    );
    options.onPrimaryBuildStarted?.(primaryBuild.child.pid);
    buildHealthRawPromise = pollHealthyDuringBuild(
      port,
      primaryBuild,
      devProcess.child.pid,
      devOutputDirectory,
      buildHealthAbortController.signal,
    );
    buildHealthPromise = within('production build health polling', BUILD_DEADLINE_MS, buildHealthRawPromise);
    buildHealthPromise.catch(() => undefined);
    let secondBuildExitCode: number | null = null;
    if (mode === 'isolated') {
      await waitForBuildLock(buildLockPath, primaryBuild);
      secondBuild = spawnOwnedProcess(
        ['bun', '--no-env-file', 'run', 'build'],
        repositoryDirectory,
        productionEnvironment,
      );
      secondBuildExitCode = await within(
        'contending production build',
        CONTENDING_BUILD_EXIT_DEADLINE_MS,
        secondBuild.child.exited,
      );
      await within(
        'contending production build log drain',
        LOG_DRAIN_DEADLINE_MS,
        Promise.all([secondBuild.stdout.done, secondBuild.stderr.done]),
      );
      const secondBuildOutput = `${secondBuild.stdout.text()}\n${secondBuild.stderr.text()}`;
      if (secondBuildExitCode === 0) {
        throw new Error('A second concurrent production build unexpectedly succeeded.');
      }
      if (!(secondBuildOutput.includes(buildLockPath) && LIVE_PID_PATTERN.test(secondBuildOutput))) {
        throw new Error(`Contending build did not report the live PID and lock path.\n${secondBuildOutput}`);
      }
    }

    const activeBuildHealthPromise = buildHealthPromise;
    buildHealthPromise = undefined;
    const buildHealth = await activeBuildHealthPromise;
    const primaryBuildExitCode = await within('primary production build', BUILD_DEADLINE_MS, primaryBuild.child.exited);
    if (primaryBuildExitCode !== 0) {
      throw new Error(
        `Primary production build failed with exit code ${primaryBuildExitCode}.\n${primaryBuild.stdout.text()}\n${primaryBuild.stderr.text()}`,
      );
    }
    const buildDurationMs = performance.now() - buildStartedAt;
    if (buildHealth.healthyRequests === 0) {
      throw new Error('Production build completed without a health sample while it was live.');
    }

    if (!(await requestApplication(port))) {
      throw new Error('Development endpoint was unhealthy after production build.');
    }
    if (devProcess.child.exitCode !== null) {
      throw new Error('Development process exited during production build.');
    }
    const checkedFiles =
      mode === 'isolated'
        ? (await assertDirectoryIdentitiesPreserved(devOutputDirectory, devOutputBefore)).checkedFiles
        : await countPreservedDirectoryIdentities(devOutputDirectory, devOutputBefore);
    const devProcessTreeAfter = await listProcessTree(devProcess.child.pid);
    if (mode === 'isolated' && devProcessTreeAfter.length !== devProcessTreeBefore.length) {
      throw new Error(
        `Development process count changed during build: ${devProcessTreeBefore.length} -> ${devProcessTreeAfter.length}.`,
      );
    }
    const deletedAfter = await countDeletedDevOutputDescriptors(devProcessTreeAfter, devOutputDirectory);
    const peakDeletedDevOutputDescriptors = Math.max(deletedBefore, buildHealth.peakDeletedDescriptors, deletedAfter);
    if (mode === 'isolated' && peakDeletedDevOutputDescriptors !== 0) {
      throw new Error(
        `Development process observed ${peakDeletedDevOutputDescriptors} deleted dev-output descriptors during build.`,
      );
    }
    const devLogsDuringBuild = `${devProcess.stdout.textSince(devStdoutPositionBeforeBuild)}\n${devProcess.stderr.textSince(
      devStderrPositionBeforeBuild,
    )}`;
    const hmrMessagesDuringBuild = devLogsDuringBuild.match(HMR_MESSAGE_PATTERN)?.length ?? 0;
    if (mode === 'isolated' && hmrMessagesDuringBuild !== 0) {
      throw new Error(`Production build triggered ${hmrMessagesDuringBuild} development HMR/reload messages.`);
    }

    operationResult = {
      buildDurationMs,
      checkedDevOutputFiles: checkedFiles,
      devPid: devProcess.child.pid,
      devProcessCountAfterBuild: devProcessTreeAfter.length,
      devReadyDurationMs: devReadiness.durationMs,
      devProcessCountBeforeBuild: devProcessTreeBefore.length,
      healthyRequestsDuringBuild: buildHealth.healthyRequests,
      hmrMessagesDuringBuild,
      mode,
      peakDeletedDevOutputDescriptors,
      secondBuildExitCode,
    };
  } catch (error) {
    operationError = error;
  }

  const ownedProcesses = [secondBuild, primaryBuild, devProcess].filter(
    (ownedProcess): ownedProcess is OwnedProcess => ownedProcess !== undefined,
  );
  const cleanupResults = await Promise.allSettled(ownedProcesses.map(stopOwnedProcess));
  buildHealthAbortController.abort(new Error('Production build health polling was stopped for cleanup.'));
  const monitorResults = buildHealthRawPromise ? await Promise.allSettled([buildHealthRawPromise]) : [];
  const cleanupFailures = cleanupResults.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  let runtimeCleanupError: unknown;
  if (cleanupFailures.length === 0) {
    try {
      await removeOwnedRuntimeRoot(runtimeRoot);
    } catch (error) {
      runtimeCleanupError = error;
    }
  }
  const failures = [
    operationError,
    ...cleanupFailures.map(({ reason }) => reason),
    ...monitorResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    runtimeCleanupError,
  ].filter((failure): failure is NonNullable<unknown> => failure !== undefined);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      cleanupFailures.length > 0
        ? 'The dev/build isolation check failed and could not terminate every process group.'
        : 'The dev/build isolation check failed.',
    );
  }
  if (!operationResult) {
    throw new Error('The dev/build isolation check completed without a result.');
  }
  return operationResult;
};

if (import.meta.main) {
  let interrupted = false;
  const handleSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    try {
      await interruptActiveWebBuildIsolationChecks();
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${message}\n`);
    } finally {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
      process.kill(process.pid, signal);
    }
  };
  const handleSigint = async (): Promise<void> => await handleSignal('SIGINT');
  const handleSigterm = async (): Promise<void> => await handleSignal('SIGTERM');
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  try {
    const result = await runWebDevBuildIsolationCheck();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (!interrupted) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  } finally {
    if (!interrupted) {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
    }
  }
}
