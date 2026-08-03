import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseSourceControlSnapshot, type SourceControlView } from '@ai-usage/report-core/source-control';
import { USAGE_ENGINE_PROTOCOL_VERSION, type UsageEngineStatus } from '@ai-usage/usage-engine-control';
import { createUsageEngineControlClient, type UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { executeUsageEngineCommandToCompletion } from '@ai-usage/usage-engine-control/completion';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import {
  queryCurrentServedReportRevision,
  queryUsageStoreGenerations,
  USAGE_STORE_SCHEMA_VERSION,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import {
  captureBoundedStream,
  createWebBuildIsolationEnvironment,
  interruptActiveWebBuildIsolationChecks,
  runWebDevBuildIsolationCheck,
  type WebDevBuildIsolationResult,
} from './check-web-dev-build-isolation';
import {
  type LinuxProcessStat,
  parseDiskSectorsWritten,
  parseLinuxProcessStat,
  parseLinuxProcessStatus,
  parseProcessIo,
} from './measure-process-tree-io';

const BLOCK_DEVICE_SECTOR_BYTES = 512;
const BUILD_DEADLINE_MS = 180_000;
const CHILD_STOP_DEADLINE_MS = 3000;
const COLD_IDLE_DEFAULT_MS = 10_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const HMR_DEFAULT_MS = 10_000;
const HMR_MESSAGE_PATTERN = /hmr update|full reload|page reload/gi;
const LEGACY_SESSION_QUERY_LEASE_PREFIX = 'ai-usage-session-query-lease-';
const LOOPBACK_HOST = '127.0.0.1';
const PROCESS_DIRECTORY_PATTERN = /^\d+$/;
const PROCESS_POLL_INTERVAL_MS = 50;
const QUERY_PROCESS_POLL_INTERVAL_MS = 10;
const READINESS_DEADLINE_MS = 60_000;
const SESSION_QUERY_NAVIGATION_DEADLINE_MS = 60_000;
const SESSION_QUERY_HYDRATION_DEADLINE_MS = 60_000;
const SESSION_QUERY_PROOF_DEADLINE_MS = 15_000;
export const usageRuntimeSessionQueryBudgets = {
  hydrationMs: SESSION_QUERY_HYDRATION_DEADLINE_MS,
  navigationMs: SESSION_QUERY_NAVIGATION_DEADLINE_MS,
  proofMs: SESSION_QUERY_PROOF_DEADLINE_MS,
  supervisorMs:
    SESSION_QUERY_NAVIGATION_DEADLINE_MS +
    SESSION_QUERY_HYDRATION_DEADLINE_MS +
    SESSION_QUERY_PROOF_DEADLINE_MS +
    2 * CHILD_STOP_DEADLINE_MS,
} as const;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RUNTIME_ROOT_PREFIX = '/tmp/plan052-usage-runtime-io-';
const SOURCE_SNAPSHOT_FRAME_LIMIT_BYTES = 128 * 1024;
const STREAM_CONNECT_ATTEMPT_MS = 2000;
const WARM_IDLE_TRACE_INTERVAL_MS = 10_000;
const WARM_IDLE_DEFAULT_MS = 10_000;
const PATH_METADATA_ENTRY_LIMIT = 100_000;
const attributableCollectionPathPrefixes = ['engine-state', 'home/.config/ai-usage', 'logs', 'store'] as const;
const runtimeMetadataExcludedPrefixes = ['source/.git', 'source/node_modules'] as const;

interface CapturedOwnedProcess {
  child: Bun.Subprocess;
  stderr: ReturnType<typeof captureBoundedStream>;
  stdout: ReturnType<typeof captureBoundedStream>;
}

export interface LegacyLeaseMeasurement {
  bytes: number;
  count: number;
}

interface MeasurementEnvironmentOptions {
  inheritedEnvironment: Record<string, string | undefined>;
  repositoryDirectory: string;
  runtimeRoot: string;
}

interface MeasuredProcessRoot {
  pid: number;
  role: string;
}

interface ProcessCounter {
  command: string;
  cpuTicks: number;
  parentPid: number;
  peakResidentBytes: number;
  peakThreads: number;
  pid: number;
  role: string;
  startTimeTicks: number;
  writeBytes: number;
}

interface ProcessDelta {
  bornDuringScenario: boolean;
  command: string;
  cpuTicksDelta: number;
  parentPid: number;
  peakResidentBytes: number;
  peakThreads: number;
  pid: number;
  role: string;
  startTimeTicks: number;
  writeBytesDelta: number;
}

interface ProcessTreeSample {
  aggregateResidentBytes: number;
  aggregateThreads: number;
  deletedDevOutputDescriptors: number;
  processes: Map<string, ProcessCounter>;
}

interface ScenarioOptions {
  blockDevice: string;
  deadlineMs: number;
  devOutputDirectory: string | undefined;
  name: string;
  operation: (signal: AbortSignal) => Promise<void>;
  pathObservationRoot?: string;
  pollIntervalMs?: number;
  roots: () => readonly MeasuredProcessRoot[];
  temporaryDirectory: string;
  traceIntervalMs?: number;
  zeroBaseline?: boolean;
}

export interface WriteTracePoint {
  elapsedMs: number;
  totalWriteBytes: number;
}

export interface ScenarioMeasurement {
  blockDeviceWriteBytes: number;
  cpuTicksDelta: number;
  deletedDevOutputDescriptors: number;
  durationMs: number;
  leaseAfter: LegacyLeaseMeasurement;
  leaseBefore: LegacyLeaseMeasurement;
  leasePeak: LegacyLeaseMeasurement;
  name: string;
  pathMutations: string[];
  peakResidentBytes: number;
  peakThreads: number;
  processes: ProcessDelta[];
  totalWriteBytes: number;
  writeTrace: WriteTracePoint[];
}

interface SourceSnapshotStream {
  close: () => Promise<void>;
  failure: () => unknown;
  latest: () => SourceControlView | undefined;
}

interface SourceSelection {
  kind: 'revision' | 'worktree';
  value: string;
}

interface RuntimeMeasurementOptions {
  blockDevice: string;
  codexSessions: number;
  coldIdleMs: number;
  concurrentMode: WebDevBuildIsolationResult['mode'];
  concurrentRuns: number;
  hmrMs: number;
  source: SourceSelection;
  warmIdleMs: number;
}

interface UsageRuntimeMeasurementResult {
  acceptance: UsageRuntimeMeasurementAcceptance;
  blockDevice: string;
  clockTicksPerSecond: number;
  concurrentBuilds: Array<{
    correctness: WebDevBuildIsolationResult;
    io: ScenarioMeasurement;
  }>;
  concurrentMode: WebDevBuildIsolationResult['mode'];
  engineRestartPreservedWebProcess: boolean;
  fixture: {
    claudeSessions: number;
    codexSessions: number;
  };
  hmrMessagesDuringHmr: number;
  hmrPreservedEngineInstance: boolean;
  hmrPreservedPublication: boolean;
  processPollIntervalMs: number;
  queryProcessPollIntervalMs: number;
  scenarios: ScenarioMeasurement[];
  source: {
    fingerprint: string;
    kind: SourceSelection['kind'];
    revision?: string;
  };
}

export interface UsageRuntimeMeasurementAcceptance {
  readonly collectionPathsAttributable: boolean;
  readonly collectionWritesAttributable: boolean;
  readonly deletedDevOutputDescriptorsAbsent: boolean;
  readonly engineRestartIsolationPreserved: boolean;
  readonly hmrStoreWritesAbsent: boolean;
  readonly legacySessionLeasesAbsent: boolean;
  readonly perQueryBunProcessesAbsent: boolean;
  readonly warmIdleWriteLoopAbsent: boolean;
}

interface SettledSnapshotShape {
  publication: {
    acknowledgedRequestGeneration: number;
    pendingDemand: boolean;
    queued: boolean;
    requestedGeneration: number;
    running: boolean;
  };
  queueDepth: number;
  runningCount: number;
  sources: readonly { lifecycle: string; progress?: unknown }[];
}

export const createUsageRuntimeMeasurementEnvironment = ({
  inheritedEnvironment,
  repositoryDirectory,
  runtimeRoot,
}: MeasurementEnvironmentOptions): Record<string, string> => ({
  ...createWebBuildIsolationEnvironment({
    inheritedEnvironment: {
      PATH: inheritedEnvironment.PATH,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: inheritedEnvironment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    repositoryDirectory,
    runtimeRoot,
    useE2eAdapters: false,
  }),
  AI_USAGE_DATABASE_PATH: path.join(runtimeRoot, 'store', 'usage.sqlite'),
  AI_USAGE_ENGINE_STATE_DIR: path.join(runtimeRoot, 'engine-state'),
  AI_USAGE_HOME: path.join(runtimeRoot, 'home'),
  AI_USAGE_TEMP_ROOT: path.join(runtimeRoot, 'tmp'),
  TURBO_CACHE_DIR: path.join(runtimeRoot, 'cache', 'turbo'),
  TURBO_DAEMON: 'false',
  TURBO_TELEMETRY_DISABLED: '1',
});

export const parseRuntimeProcessStat = (text: string): LinuxProcessStat | undefined => parseLinuxProcessStat(text);

export const isSourceControlSettled = (snapshot: SettledSnapshotShape): boolean =>
  snapshot.runningCount === 0 &&
  snapshot.queueDepth === 0 &&
  snapshot.sources.every(
    ({ lifecycle, progress }) => (lifecycle === 'scheduled' || lifecycle === 'dormant') && progress === undefined,
  ) &&
  !snapshot.publication.running &&
  !snapshot.publication.queued &&
  !snapshot.publication.pendingDemand &&
  snapshot.publication.requestedGeneration === snapshot.publication.acknowledgedRequestGeneration;

export const warmIdleWriteLoopIsAbsent = (trace: readonly WriteTracePoint[]): boolean => {
  let previousTotal = 0;
  let previousIntervalGrew = false;
  for (const point of trace) {
    const intervalGrew = point.totalWriteBytes > previousTotal;
    if (intervalGrew && previousIntervalGrew) {
      return false;
    }
    previousIntervalGrew = intervalGrew;
    previousTotal = point.totalWriteBytes;
  }
  return true;
};

export const collectionPathMutationsAreAttributable = (relativePaths: readonly string[]): boolean =>
  relativePaths.some((relativePath) => relativePath.startsWith('store/')) &&
  relativePaths.every(
    (relativePath) =>
      !path.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      attributableCollectionPathPrefixes.some(
        (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
      ),
  );

export const evaluateUsageRuntimeMeasurementAcceptance = (
  scenarios: readonly ScenarioMeasurement[],
  invariants: {
    readonly engineRestartPreservedWebProcess: boolean;
    readonly hmrPreservedEngineInstance: boolean;
    readonly hmrPreservedPublication: boolean;
  },
): UsageRuntimeMeasurementAcceptance => {
  const scenario = (name: string): ScenarioMeasurement | undefined =>
    scenarios.find((candidate) => candidate.name === name);
  const hmr = scenario('hmr');
  const collection = scenario('collection-publication');
  const sessionsQuery = scenario('sessions-query');
  const warmIdle = scenario('warm-idle');
  const hmrEngineWrites =
    hmr?.processes
      .filter(({ role }) => role === 'engine')
      .reduce((total, processMeasurement) => total + processMeasurement.writeBytesDelta, 0) ?? Number.NaN;
  const querySpawnedServerBun =
    sessionsQuery?.processes.some(
      ({ bornDuringScenario, command, role }) =>
        bornDuringScenario && role === 'dev' && command.toLowerCase().includes('bun'),
    ) ?? true;
  const retiredQueryProcess =
    sessionsQuery?.processes.some(({ role }) => role === 'revision-query' || role === 'session-materializer') ?? true;
  return {
    collectionPathsAttributable:
      collection !== undefined && collectionPathMutationsAreAttributable(collection.pathMutations),
    collectionWritesAttributable:
      collection?.processes.some(({ role, writeBytesDelta }) => role === 'engine' && writeBytesDelta > 0) === true &&
      collection?.processes.every(({ role, writeBytesDelta }) => role === 'engine' || writeBytesDelta === 0) === true,
    deletedDevOutputDescriptorsAbsent: scenarios.every(
      ({ deletedDevOutputDescriptors }) => deletedDevOutputDescriptors === 0,
    ),
    engineRestartIsolationPreserved: invariants.engineRestartPreservedWebProcess,
    hmrStoreWritesAbsent:
      hmr !== undefined &&
      hmrEngineWrites === 0 &&
      invariants.hmrPreservedEngineInstance &&
      invariants.hmrPreservedPublication,
    legacySessionLeasesAbsent: scenarios.every(
      ({ leaseAfter, leaseBefore, leasePeak }) =>
        leaseBefore.count === 0 &&
        leaseBefore.bytes === 0 &&
        leasePeak.count === 0 &&
        leasePeak.bytes === 0 &&
        leaseAfter.count === 0 &&
        leaseAfter.bytes === 0,
    ),
    perQueryBunProcessesAbsent: sessionsQuery !== undefined && !(querySpawnedServerBun || retiredQueryProcess),
    warmIdleWriteLoopAbsent:
      warmIdle !== undefined &&
      warmIdle.totalWriteBytes === 0 &&
      warmIdle.writeTrace.every(({ totalWriteBytes }) => totalWriteBytes === 0) &&
      warmIdleWriteLoopIsAbsent(warmIdle.writeTrace),
  };
};

const assertUsageRuntimeMeasurementAccepted = (
  acceptance: UsageRuntimeMeasurementAcceptance,
  scenarios: readonly ScenarioMeasurement[],
): void => {
  const failures = Object.entries(acceptance).flatMap(([criterion, passed]) => (passed ? [] : [criterion]));
  if (failures.length > 0) {
    const collectionPathDiagnostic = acceptance.collectionPathsAttributable
      ? ''
      : ` Collection path mutations: ${JSON.stringify(
          scenarios.find(({ name }) => name === 'collection-publication')?.pathMutations ?? [],
        )}.`;
    throw new Error(`Usage runtime I/O acceptance failed: ${failures.join(', ')}.${collectionPathDiagnostic}`);
  }
};

const isPrivateOwnedDirectory = async (directoryPath: string): Promise<boolean> => {
  const directoryStat = await lstat(directoryPath);
  const currentUserId = process.getuid?.();
  return (
    directoryStat.isDirectory() &&
    !directoryStat.isSymbolicLink() &&
    (currentUserId === undefined || directoryStat.uid === currentUserId) &&
    directoryStat.mode % 0o100 === 0
  );
};

const sumRegularFileBytes = async (directoryPath: string): Promise<number> => {
  let bytes = 0;
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error('A legacy Session query lease contained a symbolic link.');
    }
    if (entryStat.isDirectory()) {
      bytes += await sumRegularFileBytes(entryPath);
    } else if (entryStat.isFile()) {
      bytes += entryStat.size;
    } else {
      throw new Error('A legacy Session query lease contained a special file.');
    }
  }
  return bytes;
};

export const measureLegacySessionQueryLeases = async (temporaryDirectory: string): Promise<LegacyLeaseMeasurement> => {
  const entries = await readdir(temporaryDirectory, { withFileTypes: true });
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(LEGACY_SESSION_QUERY_LEASE_PREFIX)) {
      continue;
    }
    const leaseDirectory = path.join(temporaryDirectory, entry.name);
    if (!(await isPrivateOwnedDirectory(leaseDirectory))) {
      throw new Error('A legacy Session query lease had suspicious ownership, permissions, or type.');
    }
    count += 1;
    bytes += await sumRegularFileBytes(leaseDirectory);
  }
  return { bytes, count };
};

const runtimeMetadataIdentity = async (
  entryPath: string,
): Promise<{ readonly directory: boolean; readonly id: string }> => {
  const entryStat = await lstat(entryPath, { bigint: true });
  let kind = 'special';
  if (entryStat.isDirectory()) {
    kind = 'directory';
  } else if (entryStat.isFile()) {
    kind = 'file';
  } else if (entryStat.isSymbolicLink()) {
    kind = 'symlink';
  }
  const stableIdentity = [kind, entryStat.dev, entryStat.ino, entryStat.mode, entryStat.uid, entryStat.gid];
  return {
    directory: entryStat.isDirectory(),
    // Child entries carry their own full identity. Ignoring directory size and
    // timestamps prevents a create-then-remove temporary file from masquerading
    // as durable state while still detecting new, removed, or replaced paths.
    id: [
      ...stableIdentity,
      ...(entryStat.isDirectory() ? [] : [entryStat.size, entryStat.mtimeNs, entryStat.ctimeNs]),
    ].join(':'),
  };
};

const snapshotRuntimePathMetadata = async (rootDirectory: string): Promise<Map<string, string>> => {
  const entries = new Map<string, string>();
  const visit = async (relativePath: string): Promise<void> => {
    if (entries.size >= PATH_METADATA_ENTRY_LIMIT) {
      throw new Error(`Runtime path metadata exceeded its ${PATH_METADATA_ENTRY_LIMIT}-entry limit.`);
    }
    const entryPath = relativePath === '.' ? rootDirectory : path.join(rootDirectory, relativePath);
    const identity = await runtimeMetadataIdentity(entryPath);
    const normalizedPath = relativePath.split(path.sep).join('/');
    entries.set(normalizedPath, identity.id);
    if (
      !identity.directory ||
      runtimeMetadataExcludedPrefixes.some(
        (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
      )
    ) {
      return;
    }
    const childNames = (await readdir(entryPath)).sort();
    for (const childName of childNames) {
      await visit(relativePath === '.' ? childName : path.join(relativePath, childName));
    }
  };
  await visit('.');
  return entries;
};

const changedRuntimePaths = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((relativePath) => before.get(relativePath) !== after.get(relativePath))
    .sort();

const readText = async (filePath: string): Promise<string | undefined> => {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return;
  }
};

const readBlockDeviceSectors = async (blockDevice: string): Promise<number | undefined> => {
  const diskstats = await readText('/proc/diskstats');
  return diskstats ? parseDiskSectorsWritten(diskstats, blockDevice) : undefined;
};

const listLinuxProcessStats = async (): Promise<Map<number, LinuxProcessStat>> => {
  const result = new Map<number, LinuxProcessStat>();
  const entries = await readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!(entry.isDirectory() && PROCESS_DIRECTORY_PATTERN.test(entry.name))) {
      continue;
    }
    const pid = Number(entry.name);
    const parsed = parseLinuxProcessStat((await readText(`/proc/${pid}/stat`)) ?? '');
    if (parsed) {
      result.set(pid, parsed);
    }
  }
  return result;
};

const findMeasuredProcesses = (
  processStats: ReadonlyMap<number, LinuxProcessStat>,
  roots: readonly MeasuredProcessRoot[],
): Map<number, string> => {
  const roles = new Map(roots.map(({ pid, role }) => [pid, role]));
  let discoveredDescendant = true;
  while (discoveredDescendant) {
    discoveredDescendant = false;
    for (const [pid, processStat] of processStats) {
      if (roles.has(pid)) {
        continue;
      }
      const parentRole = roles.get(processStat.parentPid);
      const groupRole = roots.find(({ pid: rootPid }) => rootPid === processStat.processGroupId)?.role;
      const role = parentRole ?? groupRole;
      if (role) {
        roles.set(pid, role);
        discoveredDescendant = true;
      }
    }
  }
  return roles;
};

const isContainedPath = (candidate: string, container: string): boolean => {
  const relativePath = path.relative(container, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
  );
};

const countDeletedDevOutputDescriptors = async (
  pids: readonly number[],
  devOutputDirectory: string | undefined,
): Promise<number> => {
  if (!devOutputDirectory) {
    return 0;
  }
  let deletedDescriptors = 0;
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
        if (!target.endsWith(' (deleted)')) {
          continue;
        }
        const originalPath = target.slice(0, -' (deleted)'.length);
        if (isContainedPath(originalPath, devOutputDirectory)) {
          deletedDescriptors += 1;
        }
      } catch {
        // Descriptors may close between enumeration and inspection.
      }
    }
  }
  return deletedDescriptors;
};

const classifyProcessRole = async (pid: number, inheritedRole: string): Promise<string> => {
  const commandLine = (await readText(`/proc/${pid}/cmdline`))?.replaceAll('\0', ' ') ?? '';
  if (commandLine.includes('revision-query-runner.ts')) {
    return 'revision-query';
  }
  if (commandLine.includes('session-query-materialize-runner.ts')) {
    return 'session-materializer';
  }
  if (commandLine.includes('chromium')) {
    return 'browser';
  }
  return inheritedRole;
};

const sampleProcessTrees = async (
  roots: readonly MeasuredProcessRoot[],
  devOutputDirectory: string | undefined,
): Promise<ProcessTreeSample> => {
  const processStats = await listLinuxProcessStats();
  const roles = findMeasuredProcesses(processStats, roots);
  const processes = new Map<string, ProcessCounter>();
  let aggregateResidentBytes = 0;
  let aggregateThreads = 0;
  for (const [pid, inheritedRole] of roles) {
    const processStat = processStats.get(pid);
    if (!processStat) {
      continue;
    }
    const [command, io, status, role] = await Promise.all([
      readText(`/proc/${pid}/comm`),
      readText(`/proc/${pid}/io`),
      readText(`/proc/${pid}/status`),
      classifyProcessRole(pid, inheritedRole),
    ]);
    const parsedStatus = parseLinuxProcessStatus(status ?? '');
    const residentBytes = parsedStatus?.residentBytes ?? 0;
    const threads = parsedStatus?.threads ?? 0;
    aggregateResidentBytes += residentBytes;
    aggregateThreads += threads;
    const identity = `${pid}:${processStat.startTimeTicks}`;
    processes.set(identity, {
      command: command?.trim() || 'unknown',
      cpuTicks: processStat.cpuTicks,
      parentPid: processStat.parentPid,
      peakResidentBytes: residentBytes,
      peakThreads: threads,
      pid,
      role,
      startTimeTicks: processStat.startTimeTicks,
      writeBytes: parseProcessIo(io ?? '') ?? 0,
    });
  }
  const devPids = [...roles.entries()].flatMap(([pid, role]) => (role === 'dev' ? [pid] : []));
  return {
    aggregateResidentBytes,
    aggregateThreads,
    deletedDevOutputDescriptors: await countDeletedDevOutputDescriptors(devPids, devOutputDirectory),
    processes,
  };
};

const largerLeaseMeasurement = (
  left: LegacyLeaseMeasurement,
  right: LegacyLeaseMeasurement,
): LegacyLeaseMeasurement => ({
  bytes: Math.max(left.bytes, right.bytes),
  count: Math.max(left.count, right.count),
});

const mergeProcessMaximums = (
  maximums: Map<string, ProcessCounter>,
  sample: ReadonlyMap<string, ProcessCounter>,
): void => {
  for (const [identity, current] of sample) {
    const existing = maximums.get(identity);
    maximums.set(identity, {
      ...current,
      cpuTicks: Math.max(existing?.cpuTicks ?? 0, current.cpuTicks),
      peakResidentBytes: Math.max(existing?.peakResidentBytes ?? 0, current.peakResidentBytes),
      peakThreads: Math.max(existing?.peakThreads ?? 0, current.peakThreads),
      writeBytes: Math.max(existing?.writeBytes ?? 0, current.writeBytes),
    });
  }
};

const cumulativeWriteDelta = (
  maximums: ReadonlyMap<string, ProcessCounter>,
  baseline: ReadonlyMap<string, ProcessCounter>,
): number => {
  let total = 0;
  for (const [identity, processCounter] of maximums) {
    total += Math.max(0, processCounter.writeBytes - (baseline.get(identity)?.writeBytes ?? 0));
  }
  return total;
};

const measureScenario = async ({
  blockDevice,
  deadlineMs,
  devOutputDirectory,
  name,
  operation,
  pathObservationRoot,
  pollIntervalMs = PROCESS_POLL_INTERVAL_MS,
  roots,
  temporaryDirectory,
  traceIntervalMs,
  zeroBaseline = false,
}: ScenarioOptions): Promise<ScenarioMeasurement> => {
  const sectorsBefore = await readBlockDeviceSectors(blockDevice);
  if (sectorsBefore === undefined) {
    throw new Error(`Block device ${blockDevice} is absent from /proc/diskstats.`);
  }
  const leaseBefore = await measureLegacySessionQueryLeases(temporaryDirectory);
  const baselineSample = zeroBaseline
    ? { aggregateResidentBytes: 0, aggregateThreads: 0, deletedDevOutputDescriptors: 0, processes: new Map() }
    : await sampleProcessTrees(roots(), devOutputDirectory);
  const pathMetadataBefore = pathObservationRoot ? await snapshotRuntimePathMetadata(pathObservationRoot) : undefined;
  const maximums = new Map(baselineSample.processes);
  let leasePeak = leaseBefore;
  let peakResidentBytes = baselineSample.aggregateResidentBytes;
  let peakThreads = baselineSample.aggregateThreads;
  let peakDeletedDescriptors = baselineSample.deletedDevOutputDescriptors;
  const startedAt = performance.now();
  const writeTrace: WriteTracePoint[] = [];
  let nextTraceAt = traceIntervalMs;
  let completed = false;
  const abortController = new AbortController();
  const rawOperationPromise = operation(abortController.signal);
  const operationPromise = within(name, deadlineMs, rawOperationPromise);
  operationPromise.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  while (!completed) {
    const [sample, leases] = await Promise.all([
      sampleProcessTrees(roots(), devOutputDirectory),
      measureLegacySessionQueryLeases(temporaryDirectory),
    ]);
    mergeProcessMaximums(maximums, sample.processes);
    leasePeak = largerLeaseMeasurement(leasePeak, leases);
    peakResidentBytes = Math.max(peakResidentBytes, sample.aggregateResidentBytes);
    peakThreads = Math.max(peakThreads, sample.aggregateThreads);
    peakDeletedDescriptors = Math.max(peakDeletedDescriptors, sample.deletedDevOutputDescriptors);
    const elapsedMs = performance.now() - startedAt;
    if (nextTraceAt !== undefined && elapsedMs >= nextTraceAt) {
      writeTrace.push({ elapsedMs, totalWriteBytes: cumulativeWriteDelta(maximums, baselineSample.processes) });
      nextTraceAt += traceIntervalMs ?? 0;
    }
    await Promise.race([operationPromise, Bun.sleep(pollIntervalMs)]).catch(() => undefined);
  }
  try {
    await operationPromise;
  } catch (error) {
    abortController.abort(new Error(`${name} was cancelled before measurement cleanup.`));
    const processResults = await Promise.allSettled([...activeCapturedProcesses].map(stopCapturedProcess));
    const cancellationFailures = processResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    try {
      await interruptActiveWebBuildIsolationChecks();
    } catch (cleanupError) {
      cancellationFailures.push(cleanupError);
    }
    try {
      await within(`${name} operation settlement`, 5 * CHILD_STOP_DEADLINE_MS, rawOperationPromise);
    } catch (settlementError) {
      if (!(settlementError === error || abortController.signal.reason === settlementError)) {
        cancellationFailures.push(settlementError);
      }
    }
    throw new AggregateError([error, ...cancellationFailures], `${name} measurement failed.`);
  }
  const finalSample = await sampleProcessTrees(roots(), devOutputDirectory);
  mergeProcessMaximums(maximums, finalSample.processes);
  peakResidentBytes = Math.max(peakResidentBytes, finalSample.aggregateResidentBytes);
  peakThreads = Math.max(peakThreads, finalSample.aggregateThreads);
  peakDeletedDescriptors = Math.max(peakDeletedDescriptors, finalSample.deletedDevOutputDescriptors);
  if (traceIntervalMs !== undefined) {
    const elapsedMs = performance.now() - startedAt;
    const finalWriteBytes = cumulativeWriteDelta(maximums, baselineSample.processes);
    if (writeTrace.at(-1)?.totalWriteBytes !== finalWriteBytes || writeTrace.length === 0) {
      writeTrace.push({ elapsedMs, totalWriteBytes: finalWriteBytes });
    }
  }
  const leaseAfter = await measureLegacySessionQueryLeases(temporaryDirectory);
  leasePeak = largerLeaseMeasurement(leasePeak, leaseAfter);
  const sectorsAfter = await readBlockDeviceSectors(blockDevice);
  if (sectorsAfter === undefined) {
    throw new Error(`Block device ${blockDevice} disappeared from /proc/diskstats.`);
  }
  if (sectorsAfter < sectorsBefore) {
    throw new Error(`Block device ${blockDevice} write sectors regressed during ${name}.`);
  }
  const pathMutations =
    pathMetadataBefore && pathObservationRoot
      ? changedRuntimePaths(pathMetadataBefore, await snapshotRuntimePathMetadata(pathObservationRoot))
      : [];
  const processes = [...maximums.entries()]
    .map(([identity, maximum]): ProcessDelta => {
      const baseline = baselineSample.processes.get(identity);
      return {
        bornDuringScenario: baseline === undefined,
        command: maximum.command,
        cpuTicksDelta: Math.max(0, maximum.cpuTicks - (baseline?.cpuTicks ?? 0)),
        parentPid: maximum.parentPid,
        peakResidentBytes: maximum.peakResidentBytes,
        peakThreads: maximum.peakThreads,
        pid: maximum.pid,
        role: maximum.role,
        startTimeTicks: maximum.startTimeTicks,
        writeBytesDelta: Math.max(0, maximum.writeBytes - (baseline?.writeBytes ?? 0)),
      };
    })
    .sort((left, right) => left.pid - right.pid);
  return {
    blockDeviceWriteBytes: (sectorsAfter - sectorsBefore) * BLOCK_DEVICE_SECTOR_BYTES,
    cpuTicksDelta: processes.reduce((total, processMeasurement) => total + processMeasurement.cpuTicksDelta, 0),
    deletedDevOutputDescriptors: peakDeletedDescriptors,
    durationMs: performance.now() - startedAt,
    leaseAfter,
    leaseBefore,
    leasePeak,
    name,
    pathMutations,
    peakResidentBytes,
    peakThreads,
    processes,
    totalWriteBytes: processes.reduce((total, processMeasurement) => total + processMeasurement.writeBytesDelta, 0),
    writeTrace,
  };
};

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
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, durationMs);
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const spawnCapturedProcess = (
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  outputBudgetBytes?: number,
): CapturedOwnedProcess => {
  if (measurementInterruptRequested) {
    throw new Error('Measurement interruption prevents starting another child process.');
  }
  const child = Bun.spawn([...command], {
    cwd,
    detached: true,
    env: environment,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const captureOptions =
    outputBudgetBytes === undefined
      ? {}
      : { maximumRetainedBytes: outputBudgetBytes, maximumTotalBytes: outputBudgetBytes };
  const ownedProcess = {
    child,
    stderr: captureBoundedStream(child.stderr, captureOptions),
    stdout: captureBoundedStream(child.stdout, captureOptions),
  };
  activeCapturedProcesses.add(ownedProcess);
  return ownedProcess;
};

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals | 0): void => {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const processGroupIsAlive = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

const stopPromises = new WeakMap<CapturedOwnedProcess, Promise<void>>();
const activeCapturedProcesses = new Set<CapturedOwnedProcess>();
let measurementInterruptRequested = false;

const stopCapturedProcessOnce = async (ownedProcess: CapturedOwnedProcess): Promise<void> => {
  try {
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      signalProcessGroup(ownedProcess.child.pid, 'SIGTERM');
    }
    const gracefulDeadline = Date.now() + CHILD_STOP_DEADLINE_MS;
    while (processGroupIsAlive(ownedProcess.child.pid) && Date.now() < gracefulDeadline) {
      await Bun.sleep(25);
    }
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      signalProcessGroup(ownedProcess.child.pid, 'SIGKILL');
    }
    await within('owned process exit', CHILD_STOP_DEADLINE_MS, ownedProcess.child.exited);
    const forcedDeadline = Date.now() + CHILD_STOP_DEADLINE_MS;
    while (processGroupIsAlive(ownedProcess.child.pid) && Date.now() < forcedDeadline) {
      await Bun.sleep(25);
    }
    if (processGroupIsAlive(ownedProcess.child.pid)) {
      throw new Error(`Owned process group ${ownedProcess.child.pid} survived SIGKILL.`);
    }
    await Promise.all([
      within('owned stdout drain', CHILD_STOP_DEADLINE_MS, ownedProcess.stdout.done),
      within('owned stderr drain', CHILD_STOP_DEADLINE_MS, ownedProcess.stderr.done),
    ]);
  } finally {
    activeCapturedProcesses.delete(ownedProcess);
  }
};

const stopCapturedProcess = (ownedProcess: CapturedOwnedProcess): Promise<void> => {
  const existing = stopPromises.get(ownedProcess);
  if (existing) {
    return existing;
  }
  const stopping = stopCapturedProcessOnce(ownedProcess);
  stopPromises.set(ownedProcess, stopping);
  return stopping;
};

const processFailureMessage = (label: string, process: CapturedOwnedProcess, exitCode: number): string =>
  `${label} failed with exit code ${exitCode}.\n${process.stdout.text()}\n${process.stderr.text()}`;

const runRequiredCommand = async (
  label: string,
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  deadlineMs = BUILD_DEADLINE_MS,
): Promise<void> => {
  const ownedProcess = spawnCapturedProcess(command, cwd, environment);
  let operationError: unknown;
  try {
    const exitCode = await within(label, deadlineMs, ownedProcess.child.exited);
    if (exitCode !== 0) {
      throw new Error(processFailureMessage(label, ownedProcess, exitCode));
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await stopCapturedProcess(ownedProcess);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} failed.`);
  }
};

const runCapturedCommand = async (
  label: string,
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
): Promise<Uint8Array> => {
  const ownedProcess = spawnCapturedProcess(command, cwd, environment, COMMAND_OUTPUT_LIMIT_BYTES);
  let output: Uint8Array | undefined;
  let operationError: unknown;
  try {
    const [exitCode] = await within(
      label,
      BUILD_DEADLINE_MS,
      Promise.all([ownedProcess.child.exited, ownedProcess.stdout.done, ownedProcess.stderr.done]),
    );
    if (exitCode !== 0) {
      throw new Error(`${label} failed with exit code ${exitCode}: ${ownedProcess.stderr.text().slice(0, 4096)}`);
    }
    output = new TextEncoder().encode(ownedProcess.stdout.text());
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await stopCapturedProcess(ownedProcess);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} failed.`);
  }
  if (!output) {
    throw new Error(`${label} completed without captured output.`);
  }
  return output;
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

const createRuntimeControlClient = (environment: Readonly<Record<string, string>>): UsageEngineControlClient => {
  const databasePath = environment.AI_USAGE_DATABASE_PATH;
  const stateDirectory = environment.AI_USAGE_ENGINE_STATE_DIR;
  const configCwd = environment.AI_USAGE_ROOT_DIR;
  if (!(databasePath && stateDirectory && configCwd)) {
    throw new Error('Runtime control requires explicit database, state, and config paths.');
  }
  const rendezvousPath = path.join(stateDirectory, 'rendezvous.json');
  const targetId = usageEngineTargetIdFor({ configCwd, databasePath });
  return createUsageEngineControlClient({
    eventIdleTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    resolveRendezvous: async () => {
      const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
      assertUsageEngineRendezvousTarget(rendezvous, targetId);
      return rendezvous;
    },
  });
};

const waitForEngineStatus = async (
  control: UsageEngineControlClient,
  engineProcess: CapturedOwnedProcess,
  label: string,
  predicate: (status: UsageEngineStatus) => boolean,
  signal?: AbortSignal,
): Promise<UsageEngineStatus> => {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (engineProcess.child.exitCode !== null) {
      throw new Error(processFailureMessage(label, engineProcess, engineProcess.child.exitCode));
    }
    try {
      const status = await control.getStatus(signal ? { signal } : {});
      if (predicate(status)) {
        return status;
      }
    } catch {
      signal?.throwIfAborted();
    }
    await (signal ? sleepWithSignal(50, signal) : Bun.sleep(50));
  }
  throw new Error(
    `${label} did not reach its expected engine status before the deadline.\nEngine stdout:\n${engineProcess.stdout.text()}\nEngine stderr:\n${engineProcess.stderr.text()}`,
  );
};

const readyAndSettled = (status: UsageEngineStatus): boolean =>
  status.readiness === 'ready' &&
  status.storeSchemaVersion === USAGE_STORE_SCHEMA_VERSION &&
  status.currentPublication !== null &&
  status.currentPublication.revision === status.sourceControl.publication.revision &&
  isSourceControlSettled(status.sourceControl);

interface StoreBoundarySnapshot {
  readonly files: Readonly<Record<string, string | null>>;
  readonly generations: Awaited<ReturnType<typeof readUsageStoreGenerations>>;
  readonly revision: string;
}

const readUsageStoreGenerations = async (databasePath: string) =>
  await Effect.runPromise(queryUsageStoreGenerations({ dbPath: databasePath }));

const fileIdentity = async (filePath: string): Promise<string | null> => {
  try {
    const fileStat = await stat(filePath, { bigint: true });
    return [fileStat.dev, fileStat.ino, fileStat.size, fileStat.mtimeNs, fileStat.ctimeNs].join(':');
  } catch {
    return null;
  }
};

const readStoreFiles = async (databasePath: string): Promise<Readonly<Record<string, string | null>>> => {
  const [database, wal, shm] = await Promise.all([
    fileIdentity(databasePath),
    fileIdentity(`${databasePath}-wal`),
    fileIdentity(`${databasePath}-shm`),
  ]);
  return { database, shm, wal };
};

const readStoreBoundarySnapshot = async (
  databasePath: string,
  filesBeforeQueries = false,
): Promise<StoreBoundarySnapshot> => {
  const filesBefore = filesBeforeQueries ? await readStoreFiles(databasePath) : undefined;
  const [manifest, generations] = await Promise.all([
    Effect.runPromise(queryCurrentServedReportRevision({ dbPath: databasePath })),
    readUsageStoreGenerations(databasePath),
  ]);
  return {
    files: filesBefore ?? (await readStoreFiles(databasePath)),
    generations,
    revision: manifest.revision,
  };
};

const sameStoreBoundary = (left: StoreBoundarySnapshot, right: StoreBoundarySnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isSafeRelativeRepositoryPath = (relativePath: string): boolean =>
  relativePath !== '' &&
  !path.isAbsolute(relativePath) &&
  relativePath !== '..' &&
  !relativePath.startsWith(`..${path.sep}`);

const updateFingerprintFrame = (hasher: Bun.CryptoHasher, value: string | Uint8Array): void => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hasher.update(length);
  hasher.update(bytes);
};

export const copyWorktreeSource = async (
  repositoryDirectory: string,
  sourceDirectory: string,
  environment: Record<string, string>,
): Promise<string> => {
  const listedFiles = await runCapturedCommand(
    'worktree file enumeration',
    ['git', 'ls-files', '-z', '--cached'],
    repositoryDirectory,
    environment,
  );
  const relativePaths = new TextDecoder().decode(listedFiles).split('\0').filter(Boolean).sort();
  const hasher = new Bun.CryptoHasher('sha256');
  for (const relativePath of relativePaths) {
    if (!isSafeRelativeRepositoryPath(relativePath)) {
      throw new Error('Worktree enumeration returned an unsafe source path.');
    }
    const sourcePath = path.join(repositoryDirectory, relativePath);
    const destinationPath = path.join(sourceDirectory, relativePath);
    const sourceStat = await lstat(sourcePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      const target = await readlink(sourcePath);
      await symlink(target, destinationPath);
      updateFingerprintFrame(hasher, 'symlink');
      updateFingerprintFrame(hasher, String(sourceStat.mode % 0o1000));
      updateFingerprintFrame(hasher, relativePath);
      updateFingerprintFrame(hasher, target);
      continue;
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Refusing a non-file source entry: ${relativePath}`);
    }
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, sourceStat.mode % 0o1000);
    const fileBytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
    updateFingerprintFrame(hasher, 'file');
    updateFingerprintFrame(hasher, String(sourceStat.mode % 0o1000));
    updateFingerprintFrame(hasher, relativePath);
    updateFingerprintFrame(hasher, fileBytes);
  }
  return hasher.digest('hex');
};

export const validateContainedSourceSymlinks = async (sourceDirectory: string): Promise<void> => {
  const canonicalSourceDirectory = await realpath(sourceDirectory);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        let resolvedTarget: string;
        try {
          resolvedTarget = await realpath(entryPath);
        } catch {
          throw new Error('The source snapshot contains a broken or cyclic symlink.');
        }
        if (!isContainedPath(resolvedTarget, canonicalSourceDirectory)) {
          throw new Error('The source snapshot contains a symlink that escapes its private root.');
        }
        continue;
      }
      if (entryStat.isDirectory()) {
        await visit(entryPath);
      }
    }
  };
  await visit(sourceDirectory);
};

const extractRevisionSource = async (
  repositoryDirectory: string,
  sourceDirectory: string,
  revision: string,
  runtimeRoot: string,
  environment: Record<string, string>,
): Promise<void> => {
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error('Revision measurements require a full lowercase Git object ID.');
  }
  const archivePath = path.join(runtimeRoot, 'source.tar');
  await runRequiredCommand(
    'source archive',
    ['git', 'archive', '--format=tar', `--output=${archivePath}`, revision],
    repositoryDirectory,
    environment,
  );
  await runRequiredCommand(
    'source extraction',
    ['tar', '-xf', archivePath, '-C', sourceDirectory],
    runtimeRoot,
    environment,
  );
  await rm(archivePath, { force: true });
};

const copyDependencies = async (
  repositoryDirectory: string,
  sourceDirectory: string,
  environment: Record<string, string>,
): Promise<void> => {
  await runRequiredCommand(
    'dependency snapshot',
    [
      'cp',
      '-a',
      '--reflink=auto',
      path.join(repositoryDirectory, 'node_modules'),
      path.join(sourceDirectory, 'node_modules'),
    ],
    repositoryDirectory,
    environment,
  );
  await Promise.all(
    ['.nitro', '.vite', '.vite-temp'].map((entry) =>
      rm(path.join(sourceDirectory, 'node_modules', entry), { force: true, recursive: true }),
    ),
  );
};

const initializePrivateSourceRepository = async (
  sourceDirectory: string,
  environment: Record<string, string>,
): Promise<void> => {
  await runRequiredCommand(
    'private source repository initialization',
    ['git', 'init', '--quiet'],
    sourceDirectory,
    environment,
  );
  await runRequiredCommand('private source repository index', ['git', 'add', '--all'], sourceDirectory, environment);
  await runRequiredCommand(
    'private source repository commit',
    [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=plan052@invalid.example',
      '-c',
      'user.name=Plan 066 Measurement',
      'commit',
      '--quiet',
      '--message=Plan 066 private source snapshot',
    ],
    sourceDirectory,
    environment,
  );
};

const prepareSourceSnapshot = async (
  repositoryDirectory: string,
  sourceDirectory: string,
  runtimeRoot: string,
  source: SourceSelection,
  environment: Record<string, string>,
): Promise<{ fingerprint: string; revision?: string }> => {
  await mkdir(sourceDirectory, { mode: 0o700, recursive: true });
  let fingerprint: string;
  if (source.kind === 'revision') {
    await extractRevisionSource(repositoryDirectory, sourceDirectory, source.value, runtimeRoot, environment);
    fingerprint = source.value;
  } else {
    fingerprint = await copyWorktreeSource(repositoryDirectory, sourceDirectory, environment);
  }
  await initializePrivateSourceRepository(sourceDirectory, environment);
  await copyDependencies(repositoryDirectory, sourceDirectory, environment);
  await validateContainedSourceSymlinks(sourceDirectory);
  return {
    fingerprint,
    ...(source.kind === 'revision' ? { revision: source.value } : {}),
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const createFixtureCodexExecutable = async (fixtureBinDirectory: string, sourceDirectory: string): Promise<void> => {
  const executablePath = path.join(fixtureBinDirectory, 'codex');
  const fakeServerPath = path.join(
    sourceDirectory,
    'packages/local-collectors/src/test-fixtures/fake-codex-app-server.ts',
  );
  const contents = [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)} --no-env-file ${shellQuote(fakeServerPath)} "$AI_USAGE_CODEX_FIXTURE_LOG" success`,
    '',
  ].join('\n');
  await writeFile(executablePath, contents, { mode: 0o700 });
};

const SEED_FIXTURE_SCRIPT = `
  import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
  import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
  import {
    createLocalHistoryStorage,
    LocalHistoryStorage,
  } from '@ai-usage/local-machine/local-history';
  import { Effect } from 'effect';

  const home = process.env.HOME;
  const sessionCount = Number(process.env.PLAN052_CODEX_SESSION_COUNT);
  if (!home || !Number.isSafeInteger(sessionCount) || sessionCount <= 0) {
    throw new Error('The isolated fixture home and session count are required.');
  }
  await seedHarnessHome(home, {
    codexSessionCount: sessionCount,
    harnesses: ['claude', 'codex'],
  });
  await Effect.runPromise(
    writeMachineConfig({
      id: 'plan052-fixture-machine',
      label: 'Plan 066 Fixture',
    }).pipe(
      Effect.provideService(
        LocalHistoryStorage,
        createLocalHistoryStorage(home),
      ),
    ),
  );
`;

const addCollectionDeltaFixture = async (homeDirectory: string): Promise<void> => {
  const sessionsDirectory = path.join(homeDirectory, '.codex', 'sessions', '2026', '07');
  const sessionId = 'plan052-measured-collection-delta';
  await mkdir(sessionsDirectory, { mode: 0o700, recursive: true });
  await writeFile(
    path.join(sessionsDirectory, `${sessionId}.jsonl`),
    `${JSON.stringify({
      payload: { cwd: '/work/fixture-pagination', id: sessionId },
      timestamp: '2026-07-31T10:00:00.000Z',
      type: 'session_meta',
    })}\n${JSON.stringify({
      payload: {
        info: {
          total_token_usage: {
            cached_input_tokens: 2,
            input_tokens: 11,
            output_tokens: 3,
            total_tokens: 14,
          },
        },
        type: 'token_count',
      },
      timestamp: '2026-07-31T10:00:01.000Z',
      type: 'event_msg',
    })}\n`,
    { mode: 0o600 },
  );
};

interface DisabledAutonomousSources {
  readonly enabledSourceIds: UsageEngineStatus['sourceControl']['sources'][number]['id'][];
  readonly status: UsageEngineStatus;
}

const disableAutonomousSources = async (
  control: UsageEngineControlClient,
  engineProcess: CapturedOwnedProcess,
  signal?: AbortSignal,
): Promise<DisabledAutonomousSources> => {
  const initial = await waitForEngineStatus(control, engineProcess, 'source-policy boundary', readyAndSettled, signal);
  const enabledSourceIds = initial.sourceControl.sources.flatMap((source) =>
    source.policy === 'enabled' ? [source.id] : [],
  );
  for (const source of initial.sourceControl.sources) {
    if (source.policy !== 'enabled') {
      continue;
    }
    await executeUsageEngineCommandToCompletion(
      control,
      { command: 'set-source-enabled', enabled: false, sourceId: source.id },
      {
        expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
        ...(signal ? { signal } : {}),
        timeoutMs: READINESS_DEADLINE_MS,
      },
    );
  }
  return {
    enabledSourceIds,
    status: await waitForEngineStatus(
      control,
      engineProcess,
      'disabled-source quiescence',
      (status) => readyAndSettled(status) && status.sourceControl.sources.every(({ policy }) => policy === 'disabled'),
      signal,
    ),
  };
};

const restoreAutonomousSources = async (
  control: UsageEngineControlClient,
  engineProcess: CapturedOwnedProcess,
  sourceIds: readonly UsageEngineStatus['sourceControl']['sources'][number]['id'][],
): Promise<UsageEngineStatus> => {
  for (const sourceId of sourceIds) {
    await executeUsageEngineCommandToCompletion(
      control,
      { command: 'set-source-enabled', enabled: true, sourceId },
      {
        expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
        timeoutMs: READINESS_DEADLINE_MS,
      },
    );
  }
  const enabledSourceIds = new Set(sourceIds);
  return await waitForEngineStatus(
    control,
    engineProcess,
    'restored-source quiescence',
    (status) =>
      readyAndSettled(status) &&
      status.sourceControl.sources.every(({ id, policy }) => !enabledSourceIds.has(id) || policy === 'enabled'),
  );
};

const parseSnapshotFrame = (frame: string): SourceControlView | undefined => {
  const lines = frame.split('\n');
  if (!lines.some((line) => line.trim() === 'event: snapshot')) {
    return;
  }
  const dataLines = lines.flatMap((line) => (line.startsWith('data: ') ? [line.slice('data: '.length)] : []));
  if (dataLines.length === 0) {
    return;
  }
  return parseSourceControlSnapshot(JSON.parse(dataLines.join('\n')) as unknown);
};

const connectSourceSnapshotStream = async (
  baseUrl: string,
  cancellationSignal?: AbortSignal,
): Promise<SourceSnapshotStream> => {
  const abortController = new AbortController();
  const connectionTimeout = setTimeout(() => abortController.abort(), STREAM_CONNECT_ATTEMPT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/source-control`, {
      headers: { accept: 'text/event-stream' },
      signal: cancellationSignal
        ? AbortSignal.any([abortController.signal, cancellationSignal])
        : abortController.signal,
    });
  } finally {
    clearTimeout(connectionTimeout);
  }
  if (!(response.ok && response.body)) {
    abortController.abort();
    throw new Error(`Source snapshot stream returned HTTP ${response.status}.`);
  }
  let latestSnapshot: SourceControlView | undefined;
  let streamFailure: unknown;
  let closing = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buffered = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!closing) {
            streamFailure = new Error('Source snapshot stream closed unexpectedly.');
          }
          return;
        }
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        if (new TextEncoder().encode(buffered).byteLength > SOURCE_SNAPSHOT_FRAME_LIMIT_BYTES) {
          throw new Error('Source snapshot stream exceeded its frame buffer.');
        }
        let frameEnd = buffered.indexOf('\n\n');
        while (frameEnd >= 0) {
          const frame = buffered.slice(0, frameEnd);
          buffered = buffered.slice(frameEnd + 2);
          latestSnapshot = parseSnapshotFrame(frame) ?? latestSnapshot;
          frameEnd = buffered.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!closing) {
        streamFailure = error;
      }
    }
  })();
  return {
    close: async () => {
      closing = true;
      abortController.abort();
      await reader.cancel().catch(() => undefined);
      await within('source snapshot stream close', CHILD_STOP_DEADLINE_MS, done);
    },
    failure: () => streamFailure,
    latest: () => latestSnapshot,
  };
};

const waitForSourceSnapshotConnection = async (
  baseUrl: string,
  devProcess: CapturedOwnedProcess,
  signal?: AbortSignal,
): Promise<SourceSnapshotStream> => {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (devProcess.child.exitCode !== null) {
      throw new Error(
        `Development server exited before readiness.\n${devProcess.stdout.text()}\n${devProcess.stderr.text()}`,
      );
    }
    try {
      return await connectSourceSnapshotStream(baseUrl, signal);
    } catch {
      signal?.throwIfAborted();
      await (signal ? sleepWithSignal(100, signal) : Bun.sleep(100));
    }
  }
  throw new Error('Development source snapshot stream did not become ready.');
};

const waitForSnapshot = async (
  stream: SourceSnapshotStream,
  label: string,
  predicate: (snapshot: SourceControlView) => boolean,
  deadlineMs = READINESS_DEADLINE_MS,
  signal?: AbortSignal,
): Promise<SourceControlView> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const streamFailure = stream.failure();
    if (streamFailure !== undefined) {
      throw streamFailure;
    }
    const snapshot = stream.latest();
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }
    await (signal ? sleepWithSignal(25, signal) : Bun.sleep(25));
  }
  const latest = stream.latest();
  const safeState = latest
    ? JSON.stringify({
        generation: latest.generation,
        publication: latest.publication,
        queueDepth: latest.queueDepth,
        runningCount: latest.runningCount,
        sources: latest.sources.map(({ id, lastOutcome, lastStartedAt, lifecycle }) => ({
          id,
          lastOutcome,
          lastStartedAt: lastStartedAt ?? null,
          lifecycle,
        })),
      })
    : 'no snapshot received';
  throw new Error(`${label} did not settle before its ${deadlineMs}ms deadline. Latest state: ${safeState}`);
};

const publicationIsSettled = (snapshot: SourceControlView): boolean =>
  !(snapshot.publication.running || snapshot.publication.queued || snapshot.publication.pendingDemand) &&
  snapshot.publication.requestedGeneration === snapshot.publication.acknowledgedRequestGeneration;

const sourceStartFingerprint = (snapshot: SourceControlView): string =>
  JSON.stringify(snapshot.sources.map(({ id, lastStartedAt }) => [id, lastStartedAt ?? null]));

const requestApplication = async (baseUrl: string, signal?: AbortSignal, pathname = '/'): Promise<void> => {
  const timeoutSignal = AbortSignal.timeout(5000);
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
  });
  const body = await response.text();
  if (!(response.status === 200 && body.includes('Usage report'))) {
    throw new Error(`Development application ${pathname} returned HTTP ${response.status} without the report shell.`);
  }
};

const warmDisconnectedCommandRoute = async (baseUrl: string): Promise<void> => {
  const response = await fetch(`${baseUrl}/api/source-control/command`, {
    body: '{"command":"detect-all"}',
    headers: {
      'content-type': 'application/json',
      host: new URL(baseUrl).host,
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
    },
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (!(response.status === 503 && body.includes('engine-unavailable'))) {
    throw new Error(`Disconnected command warmup returned unexpected HTTP ${response.status}.`);
  }
};

const warmDevelopmentCompiler = async (
  sourceDirectory: string,
  runtimeRoot: string,
  fixtureBinDirectory: string,
  inheritedEnvironment: Record<string, string | undefined>,
): Promise<void> => {
  const warmupRoot = path.join(runtimeRoot, 'compiler-warmup');
  await mkdir(warmupRoot, { mode: 0o700, recursive: true });
  await createRuntimeDirectories(warmupRoot);
  const environment = {
    ...createUsageRuntimeMeasurementEnvironment({
      inheritedEnvironment,
      repositoryDirectory: sourceDirectory,
      runtimeRoot: warmupRoot,
    }),
    AI_USAGE_CODEX_FIXTURE_LOG: path.join(warmupRoot, 'logs', 'codex-requests.json'),
    PATH: [fixtureBinDirectory, inheritedEnvironment.PATH ?? ''].filter(Boolean).join(path.delimiter),
  };
  await runRequiredCommand(
    'compiler warmup store preparation',
    [
      process.execPath,
      '--no-env-file',
      path.join(sourceDirectory, 'apps', 'usage-engine', 'src', 'main.ts'),
      'once',
      JSON.stringify({
        command: { command: 'publish' },
        commandId: 'compiler-warmup-publication',
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      }),
    ],
    sourceDirectory,
    environment,
    READINESS_DEADLINE_MS,
  );
  const port = await reserveFreePort();
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
  const warmupProcess = spawnCapturedProcess(
    [
      process.execPath,
      '--no-env-file',
      '--bun',
      'vite',
      '--host',
      LOOPBACK_HOST,
      '--port',
      String(port),
      '--strictPort',
    ],
    path.join(sourceDirectory, 'apps', 'web'),
    environment,
  );
  let operationError: unknown;
  try {
    const deadline = Date.now() + READINESS_DEADLINE_MS;
    let ready = false;
    let lastProbeFailure: unknown;
    while (!ready && Date.now() < deadline) {
      if (warmupProcess.child.exitCode !== null) {
        throw new Error(
          `Compiler warmup exited before readiness.\n${warmupProcess.stdout.text()}\n${warmupProcess.stderr.text()}`,
        );
      }
      try {
        await requestApplication(baseUrl);
        await requestApplication(baseUrl, undefined, '/?tab=sessions');
        await warmDisconnectedCommandRoute(baseUrl);
        ready = true;
      } catch (error) {
        lastProbeFailure = error;
        await Bun.sleep(100);
      }
    }
    if (!ready) {
      throw new Error(
        `Compiler warmup did not become ready before its deadline. Last probe: ${
          lastProbeFailure instanceof Error ? lastProbeFailure.message : String(lastProbeFailure)
        }.\nWarmup stdout:\n${warmupProcess.stdout.text()}\nWarmup stderr:\n${warmupProcess.stderr.text()}`,
      );
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await stopCapturedProcess(warmupProcess);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Development compiler warmup failed.');
  }
};

const SESSION_QUERY_SCRIPT = `
  import { chromium } from '@playwright/test';

  const baseUrl = process.env.PLAN052_BASE_URL;
  const expectedRevision = process.env.PLAN052_EXPECTED_REVISION;
  if (!(baseUrl && expectedRevision)) {
    throw new Error('PLAN052_BASE_URL and PLAN052_EXPECTED_REVISION are required.');
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  process.stderr.write('sessions-query stage=launch\\n');
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    process.stderr.write('sessions-query stage=browser-launched\\n');
    process.stderr.write('sessions-query stage=navigate\\n');
    const page = await browser.newPage({ viewport: { height: 900, width: 1024 } });
    process.stderr.write('sessions-query stage=page-created\\n');
    const rpcStatuses = [];
    const clientErrors = [];
    const failedResponses = [];
    const pendingRequests = new Set();
    const requestFailures = [];
    const responseReads = [];
    let exactSessionResponse = false;
    const diagnosticEntryLimit = 20;
    const diagnosticValueLimit = 500;
    const appendDiagnostic = (entries, value) => {
      if (entries.length >= diagnosticEntryLimit) {
        entries.shift();
      }
      entries.push(String(value).slice(0, diagnosticValueLimit));
    };
    const boundedUrl = (value) => {
      try {
        const parsed = new URL(value);
        return (parsed.pathname + parsed.search).slice(0, diagnosticValueLimit);
      } catch {
        return String(value).slice(0, diagnosticValueLimit);
      }
    };
    page.on('console', (message) => {
      if (message.type() === 'error') {
        appendDiagnostic(clientErrors, 'console:' + message.text());
      }
    });
    page.on('pageerror', (error) => appendDiagnostic(clientErrors, 'page:' + error.message));
    page.on('request', (request) => {
      if (pendingRequests.size >= diagnosticEntryLimit) {
        const oldest = pendingRequests.values().next().value;
        if (oldest !== undefined) {
          pendingRequests.delete(oldest);
        }
      }
      pendingRequests.add(boundedUrl(request.url()));
    });
    page.on('requestfinished', (request) => pendingRequests.delete(boundedUrl(request.url())));
    page.on('requestfailed', (request) => {
      const url = boundedUrl(request.url());
      pendingRequests.delete(url);
      appendDiagnostic(requestFailures, url + ':' + String(request.failure()?.errorText ?? 'unknown'));
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        appendDiagnostic(failedResponses, boundedUrl(response.url()) + ':' + String(response.status()));
      }
      if (new URL(response.url()).pathname.startsWith('/rpc/')) {
        appendDiagnostic(rpcStatuses, new URL(response.url()).pathname + ':' + String(response.status()));
        responseReads.push(
          response.text().then((body) => {
            if (body.includes(expectedRevision) && /session-query-v1:[0-9a-f]{16}/.test(body)) {
              exactSessionResponse = true;
            }
          }),
        );
      }
    });
    await page.goto(baseUrl + '/?tab=sessions', {
      timeout: ${SESSION_QUERY_NAVIGATION_DEADLINE_MS},
      waitUntil: 'domcontentloaded',
    });
    process.stderr.write('sessions-query stage=dom-content-loaded\\n');
    const report = page.locator('main[data-hydrated="true"]');
    try {
      await report.waitFor({ state: 'visible', timeout: ${SESSION_QUERY_HYDRATION_DEADLINE_MS} });
    } catch (error) {
      const main = page.locator('main').first();
      const mainCount = await main.count();
      const mainState =
        mainCount === 0
          ? { count: 0 }
          : {
              count: mainCount,
              hydrated: await main.getAttribute('data-hydrated'),
              text: (await main.innerText()).slice(0, 1000),
            };
      throw new AggregateError(
        [
          error,
          new Error(
            'Sessions hydration diagnostics: main=' +
              JSON.stringify(mainState) +
              '; rpcStatuses=' +
              JSON.stringify(rpcStatuses.slice(-20)) +
              '; failedResponses=' +
              JSON.stringify(failedResponses.slice(-20)) +
              '; pendingRequests=' +
              JSON.stringify([...pendingRequests].slice(-20)) +
              '; requestFailures=' +
              JSON.stringify(requestFailures.slice(-20)) +
              '; clientErrors=' +
              JSON.stringify(clientErrors.slice(-20)),
          ),
        ],
        'Sessions hydration failed.',
      );
    }
    process.stderr.write('sessions-query stage=hydrated\\n');
    const proofDeadline = Date.now() + ${SESSION_QUERY_PROOF_DEADLINE_MS};
    while (!exactSessionResponse && Date.now() < proofDeadline) {
      await Promise.all(responseReads);
      await Bun.sleep(25);
    }
    if (!exactSessionResponse) {
      const unavailableCount = await page.getByText('Report data is unavailable.', { exact: true }).count();
      throw new Error(
        'Sessions revision did not resolve; rpcStatuses=' +
          JSON.stringify(rpcStatuses) +
          '; unavailableCount=' +
          String(unavailableCount) +
          '; clientErrors=' +
          JSON.stringify(clientErrors),
      );
    }
    process.stderr.write('sessions-query stage=revision\\n');
  } finally {
    process.stderr.write('sessions-query stage=close\\n');
    await browser.close();
  }
`;

const runSessionQuery = async (
  sourceDirectory: string,
  environment: Record<string, string>,
  assignProcess: (process: CapturedOwnedProcess) => void,
): Promise<void> => {
  const queryProcess = spawnCapturedProcess(
    [process.execPath, '--no-env-file', '-e', SESSION_QUERY_SCRIPT],
    sourceDirectory,
    environment,
  );
  assignProcess(queryProcess);
  let operationError: unknown;
  try {
    const exitCode = await within(
      'Sessions browser query',
      usageRuntimeSessionQueryBudgets.supervisorMs,
      queryProcess.child.exited,
    );
    if (exitCode !== 0) {
      throw new Error(processFailureMessage('Sessions browser query', queryProcess, exitCode));
    }
  } catch (error) {
    operationError = new AggregateError(
      [
        error,
        new Error(`Sessions stdout:\n${queryProcess.stdout.text()}\nSessions stderr:\n${queryProcess.stderr.text()}`),
      ],
      'Sessions browser query operation failed.',
    );
  }
  let cleanupError: unknown;
  try {
    await stopCapturedProcess(queryProcess);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Sessions browser query failed.');
  }
};

const runMeasuredBuild = async (
  sourceDirectory: string,
  environment: Record<string, string>,
  assignProcess: (process: CapturedOwnedProcess) => void,
): Promise<void> => {
  const buildProcess = spawnCapturedProcess(
    [process.execPath, '--no-env-file', 'run', '--cwd', 'apps/web', 'build'],
    sourceDirectory,
    environment,
  );
  assignProcess(buildProcess);
  let operationError: unknown;
  try {
    const exitCode = await within('production build', BUILD_DEADLINE_MS, buildProcess.child.exited);
    if (exitCode !== 0) {
      throw new Error(processFailureMessage('Production build', buildProcess, exitCode));
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await stopCapturedProcess(buildProcess);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Production build measurement failed.');
  }
};

const measureConcurrentBuild = async (
  sourceDirectory: string,
  runtimeRoot: string,
  temporaryDirectory: string,
  blockDevice: string,
  mode: WebDevBuildIsolationResult['mode'],
  runNumber: number,
): Promise<{ correctness: WebDevBuildIsolationResult; io: ScenarioMeasurement }> => {
  let buildPid: number | undefined;
  let devOutputDirectory: string | undefined;
  let devPid: number | undefined;
  let releasePrimaryBuild: (() => void) | undefined;
  const primaryBuildRelease = new Promise<void>((resolve) => {
    releasePrimaryBuild = resolve;
  });
  let reportReady: ((context: { devOutputDirectory: string; devPid: number }) => void) | undefined;
  const ready = new Promise<{ devOutputDirectory: string; devPid: number }>((resolve) => {
    reportReady = resolve;
  });
  const checkPromise = runWebDevBuildIsolationCheck({
    beforePrimaryBuild: async (context) => {
      devOutputDirectory = context.devOutputDirectory;
      devPid = context.devPid;
      reportReady?.(context);
      await primaryBuildRelease;
    },
    mode,
    onPrimaryBuildStarted: (pid) => {
      buildPid = pid;
    },
    repositoryDirectory: sourceDirectory,
    runtimeParentDirectory: runtimeRoot,
  });
  try {
    await within(
      'concurrent dev readiness',
      BUILD_DEADLINE_MS,
      Promise.race([
        ready,
        checkPromise.then(() => {
          throw new Error('The dev/build check completed before its measurement barrier.');
        }),
      ]),
    );
  } catch (error) {
    releasePrimaryBuild?.();
    const cleanupFailures: unknown[] = [];
    try {
      await interruptActiveWebBuildIsolationChecks();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await within('failed concurrent check settlement', 5 * CHILD_STOP_DEADLINE_MS, checkPromise);
    } catch (settlementError) {
      if (settlementError !== error) {
        cleanupFailures.push(settlementError);
      }
    }
    throw new AggregateError([error, ...cleanupFailures], 'Concurrent dev readiness failed.');
  }
  if (!(devOutputDirectory && devPid && releasePrimaryBuild)) {
    throw new Error('The dev/build measurement barrier did not publish owned process state.');
  }
  const measuredDevPid = devPid;
  const startPrimaryBuild = releasePrimaryBuild;
  let correctness: WebDevBuildIsolationResult | undefined;
  let scenarioError: unknown;
  let io: ScenarioMeasurement | undefined;
  try {
    io = await measureScenario({
      blockDevice,
      deadlineMs: BUILD_DEADLINE_MS,
      devOutputDirectory: undefined,
      name: `build-with-dev-${runNumber}`,
      operation: async (signal) => {
        startPrimaryBuild();
        correctness = await Promise.race([checkPromise, waitForAbort(signal)]);
      },
      pollIntervalMs: 250,
      roots: () => [{ pid: measuredDevPid, role: 'dev' }, ...(buildPid ? [{ pid: buildPid, role: 'build' }] : [])],
      temporaryDirectory,
    });
  } catch (error) {
    scenarioError = error;
  }
  startPrimaryBuild();
  let checkError: unknown;
  try {
    correctness ??= await checkPromise;
  } catch (error) {
    checkError = error;
  }
  const failures = [scenarioError, checkError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Concurrent dev/build measurement failed.');
  }
  if (!(correctness && io)) {
    throw new Error('Concurrent dev/build measurement completed without a result.');
  }
  return { correctness, io };
};

const existingDirectory = async (...candidates: readonly string[]): Promise<string | undefined> => {
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch {
      // The next known output convention may exist instead.
    }
  }
  return;
};

const readClockTicksPerSecond = async (
  repositoryDirectory: string,
  environment: Record<string, string>,
): Promise<number> => {
  const output = await runCapturedCommand('clock tick query', ['getconf', 'CLK_TCK'], repositoryDirectory, environment);
  const clockTicks = Number(new TextDecoder().decode(output).trim());
  if (!(Number.isSafeInteger(clockTicks) && clockTicks > 0)) {
    throw new Error('getconf CLK_TCK returned an invalid value.');
  }
  return clockTicks;
};

const createRuntimeDirectories = async (runtimeRoot: string): Promise<void> => {
  await Promise.all(
    ['cache', 'config', 'data', 'engine-state', 'fixture-bin', 'home', 'logs', 'store', 'tmp'].map((directory) =>
      mkdir(path.join(runtimeRoot, directory), { mode: 0o700, recursive: true }),
    ),
  );
};

const makeOwnedTreeWritable = async (entryPath: string): Promise<void> => {
  const entryStat = await lstat(entryPath);
  if (entryStat.isSymbolicLink()) {
    return;
  }
  if (entryStat.isDirectory()) {
    await chmod(entryPath, 0o700);
    const entries = await readdir(entryPath);
    for (const entry of entries) {
      await makeOwnedTreeWritable(path.join(entryPath, entry));
    }
    return;
  }
  await chmod(entryPath, 0o600);
};

const removeOwnedRuntimeRoot = async (runtimeRoot: string): Promise<void> => {
  const rootStat = await lstat(runtimeRoot);
  const currentUserId = process.getuid?.();
  if (
    !(runtimeRoot.startsWith(RUNTIME_ROOT_PREFIX) && rootStat.isDirectory()) ||
    rootStat.isSymbolicLink() ||
    (currentUserId !== undefined && rootStat.uid !== currentUserId)
  ) {
    throw new Error('Refusing to remove an invalid measurement root.');
  }
  await makeOwnedTreeWritable(runtimeRoot);
  await rm(runtimeRoot, { force: true, recursive: true });
};

const ensureSourceDidNotRun = (before: SourceControlView, after: SourceControlView, label: string): void => {
  if (sourceStartFingerprint(before) !== sourceStartFingerprint(after)) {
    throw new Error(`${label} unexpectedly started a collection source.`);
  }
};

const ensurePublicationDidNotAdvance = (before: SourceControlView, after: SourceControlView, label: string): void => {
  if (
    before.publication.requestedGeneration !== after.publication.requestedGeneration ||
    before.publication.publishedGeneration !== after.publication.publishedGeneration ||
    before.publication.revision !== after.publication.revision
  ) {
    throw new Error(`${label} unexpectedly changed publication state.`);
  }
};

type MeasurementCleanup = (removeRoot: boolean) => Promise<unknown[]>;
type MeasurementRootRemoval = () => Promise<unknown[]>;

const activeMeasurementCleanups = new Set<MeasurementCleanup>();
const activeMeasurementRootRemovals = new Set<MeasurementRootRemoval>();

export const interruptActiveUsageRuntimeMeasurements = async (removeRoots = true): Promise<void> => {
  measurementInterruptRequested = true;
  const cleanupResults = await Promise.all([...activeMeasurementCleanups].map((cleanup) => cleanup(removeRoots)));
  const failures = cleanupResults.flat();
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Interrupted measurement cleanup failed.');
  }
};

const removeActiveUsageRuntimeMeasurementRoots = async (): Promise<void> => {
  const cleanupResults = await Promise.all([...activeMeasurementRootRemovals].map((cleanup) => cleanup()));
  const failures = cleanupResults.flat();
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Interrupted measurement root cleanup failed.');
  }
};

interface MeasurementCleanupLifecycle {
  readonly cleanup: (removeRoot?: boolean) => Promise<unknown[]>;
  readonly register: () => void;
}

const createMeasurementCleanupLifecycle = (
  runtimeRoot: string,
  ownedProcesses: Set<CapturedOwnedProcess>,
  snapshotStream: {
    clear: () => void;
    current: () => SourceSnapshotStream | undefined;
  },
): MeasurementCleanupLifecycle => {
  let cleanupPromise: Promise<unknown[]> | undefined;
  let rootRemovalPromise: Promise<unknown[]> | undefined;
  const removeMeasurementRoot = (): Promise<unknown[]> => {
    rootRemovalPromise ??= (async () => {
      try {
        await removeOwnedRuntimeRoot(runtimeRoot);
        return [];
      } catch (error) {
        return [error];
      }
    })().finally(() => activeMeasurementRootRemovals.delete(removeMeasurementRoot));
    return rootRemovalPromise;
  };
  const cleanup = (removeRoot = true): Promise<unknown[]> => {
    cleanupPromise ??= (async () => {
      const cleanupFailures: unknown[] = [];
      const activeSnapshotStream = snapshotStream.current();
      if (activeSnapshotStream) {
        try {
          await activeSnapshotStream.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
        snapshotStream.clear();
      }
      const processes = new Set([...ownedProcesses, ...activeCapturedProcesses]);
      const processCleanupResults = await Promise.allSettled([...processes].map(stopCapturedProcess));
      const processCleanupFailures = processCleanupResults.flatMap((cleanupResult) =>
        cleanupResult.status === 'rejected' ? [cleanupResult.reason] : [],
      );
      cleanupFailures.push(...processCleanupFailures);
      if (removeRoot && processCleanupFailures.length === 0) {
        cleanupFailures.push(...(await removeMeasurementRoot()));
      }
      return cleanupFailures;
    })().finally(() => activeMeasurementCleanups.delete(cleanup));
    return cleanupPromise;
  };
  return {
    cleanup,
    register: () => {
      activeMeasurementRootRemovals.add(removeMeasurementRoot);
      activeMeasurementCleanups.add(cleanup);
    },
  };
};

interface PreparedMeasurementFixture {
  readonly baseUrl: string;
  readonly clockTicksPerSecond: number;
  readonly control: UsageEngineControlClient;
  readonly databasePath: string;
  readonly environment: Record<string, string>;
  readonly fixtureBinDirectory: string;
  readonly port: number;
  readonly repositoryDirectory: string;
  readonly sourceDirectory: string;
  readonly sourceIdentity: Awaited<ReturnType<typeof prepareSourceSnapshot>>;
  readonly temporaryDirectory: string;
  readonly webDirectory: string;
}

const prepareMeasurementFixture = async (
  options: RuntimeMeasurementOptions,
  runtimeRoot: string,
): Promise<PreparedMeasurementFixture> => {
  const repositoryDirectory = path.resolve(import.meta.dirname, '..');
  const sourceDirectory = path.join(runtimeRoot, 'source');
  const temporaryDirectory = path.join(runtimeRoot, 'tmp');
  const webDirectory = path.join(sourceDirectory, 'apps', 'web');
  const fixtureBinDirectory = path.join(runtimeRoot, 'fixture-bin');
  await createRuntimeDirectories(runtimeRoot);
  const snapshotEnvironment = createUsageRuntimeMeasurementEnvironment({
    inheritedEnvironment: process.env,
    repositoryDirectory,
    runtimeRoot,
  });
  const sourceIdentity = await prepareSourceSnapshot(
    repositoryDirectory,
    sourceDirectory,
    runtimeRoot,
    options.source,
    snapshotEnvironment,
  );
  await createFixtureCodexExecutable(fixtureBinDirectory, sourceDirectory);
  const environment: Record<string, string> = {
    ...createUsageRuntimeMeasurementEnvironment({
      inheritedEnvironment: process.env,
      repositoryDirectory: sourceDirectory,
      runtimeRoot,
    }),
    AI_USAGE_CODEX_FIXTURE_LOG: path.join(runtimeRoot, 'logs', 'codex-requests.json'),
    PATH: [fixtureBinDirectory, snapshotEnvironment.PATH].filter(Boolean).join(path.delimiter),
    PLAN052_CODEX_SESSION_COUNT: String(options.codexSessions),
  };
  await runRequiredCommand(
    'fixture seeding',
    [process.execPath, '--no-env-file', '-e', SEED_FIXTURE_SCRIPT],
    sourceDirectory,
    environment,
    READINESS_DEADLINE_MS,
  );
  await runRequiredCommand(
    'design-system preparation',
    [process.execPath, '--no-env-file', '--filter', '@ai-usage/design-system', 'build'],
    sourceDirectory,
    environment,
  );
  await runRequiredCommand(
    'web development preparation',
    [process.execPath, '--no-env-file', 'run', 'dev:prepare'],
    webDirectory,
    environment,
  );
  await warmDevelopmentCompiler(sourceDirectory, runtimeRoot, fixtureBinDirectory, {
    PATH: environment.PATH,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const clockTicksPerSecond = await readClockTicksPerSecond(sourceDirectory, environment);
  const port = await reserveFreePort();
  const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
  const databasePath = environment.AI_USAGE_DATABASE_PATH;
  if (!databasePath) {
    throw new Error('The measured runtime requires an explicit database path.');
  }
  return {
    baseUrl,
    clockTicksPerSecond,
    control: createRuntimeControlClient(environment),
    databasePath,
    environment,
    fixtureBinDirectory,
    port,
    repositoryDirectory,
    sourceDirectory,
    sourceIdentity,
    temporaryDirectory,
    webDirectory,
  };
};

interface MeasurementSnapshotStreamState {
  current: SourceSnapshotStream | undefined;
}

const runUsageRuntimeMeasurementScenarios = async (
  options: RuntimeMeasurementOptions,
  runtimeRoot: string,
  ownedProcesses: Set<CapturedOwnedProcess>,
  snapshotStreamState: MeasurementSnapshotStreamState,
): Promise<UsageRuntimeMeasurementResult> => {
  const fixture = await prepareMeasurementFixture(options, runtimeRoot);
  const {
    baseUrl,
    clockTicksPerSecond,
    control,
    databasePath,
    environment,
    port,
    sourceDirectory,
    sourceIdentity,
    temporaryDirectory,
    webDirectory,
  } = fixture;
  let engineProcess: CapturedOwnedProcess | undefined;
  let webProcess: CapturedOwnedProcess | undefined;
  let queryProcess: CapturedOwnedProcess | undefined;
  let buildProcess: CapturedOwnedProcess | undefined;
  let engineRestartPreservedWebProcess = false;
  let hmrMessagesDuringHmr = 0;
  let hmrPreservedEngineInstance = false;
  let hmrPreservedPublication = false;
  const scenarios: ScenarioMeasurement[] = [];

  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: 2 * READINESS_DEADLINE_MS + 5 * CHILD_STOP_DEADLINE_MS,
      devOutputDirectory: undefined,
      name: 'cold-start',
      operation: async (signal) => {
        engineProcess = spawnCapturedProcess(
          [process.execPath, '--no-env-file', 'run', 'dev:engine'],
          sourceDirectory,
          environment,
        );
        ownedProcesses.add(engineProcess);
        await waitForEngineStatus(control, engineProcess, 'cold-start engine', readyAndSettled, signal);
        webProcess = spawnCapturedProcess(
          [
            process.execPath,
            '--no-env-file',
            '--bun',
            'vite',
            '--host',
            LOOPBACK_HOST,
            '--port',
            String(port),
            '--strictPort',
          ],
          webDirectory,
          environment,
        );
        ownedProcesses.add(webProcess);
        snapshotStreamState.current = await waitForSourceSnapshotConnection(baseUrl, webProcess, signal);
        await requestApplication(baseUrl, signal);
        try {
          const sourceSnapshot = await waitForSnapshot(
            snapshotStreamState.current,
            'cold-start publication',
            (snapshot) => publicationIsSettled(snapshot) && isSourceControlSettled(snapshot),
            READINESS_DEADLINE_MS,
            signal,
          );
          const engineStatus = await waitForEngineStatus(
            control,
            engineProcess,
            'cold-start convergence',
            readyAndSettled,
            signal,
          );
          if (engineStatus.currentPublication?.revision !== sourceSnapshot.publication.revision) {
            throw new Error('Web and engine did not converge on the same cold-start revision.');
          }
        } catch (error) {
          throw new AggregateError(
            [
              error,
              new Error(
                `Engine stdout:\n${engineProcess.stdout.text()}\nEngine stderr:\n${engineProcess.stderr.text()}\nWeb stdout:\n${webProcess.stdout.text()}\nWeb stderr:\n${webProcess.stderr.text()}`,
              ),
            ],
            'Cold-start readiness failed.',
          );
        }
      },
      roots: () => [
        ...(engineProcess ? [{ pid: engineProcess.child.pid, role: 'engine' }] : []),
        ...(webProcess ? [{ pid: webProcess.child.pid, role: 'dev' }] : []),
      ],
      temporaryDirectory,
      zeroBaseline: true,
    }),
  );
  if (!(engineProcess && webProcess && snapshotStreamState.current)) {
    throw new Error('Split development runtime completed cold start without both owned process groups.');
  }
  const runningEngineProcess = engineProcess;
  const runningWebProcess = webProcess;
  const runningSnapshotStream = snapshotStreamState.current;
  const devOutputDirectory = await existingDirectory(
    path.join(webDirectory, '.output-dev'),
    path.join(webDirectory, '.output'),
  );
  const engineTarget = path.join(sourceDirectory, 'apps', 'usage-engine', 'src', 'main.ts');
  const engineTargetStat = await stat(engineTarget);
  const engineTargetContents = new Uint8Array(await Bun.file(engineTarget).arrayBuffer());
  const engineRuntimeTarget = path.join(sourceDirectory, 'packages', 'usage-engine-runtime', 'src', 'live.ts');
  const engineRuntimeTargetStat = await stat(engineRuntimeTarget);
  const engineRuntimeTargetContents = new Uint8Array(await Bun.file(engineRuntimeTarget).arrayBuffer());
  const beforeEngineRestart = await waitForEngineStatus(
    control,
    runningEngineProcess,
    'engine-restart boundary',
    readyAndSettled,
  );
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: 2 * READINESS_DEADLINE_MS,
      devOutputDirectory,
      name: 'engine-restart',
      operation: async (signal) => {
        await writeFile(engineTarget, Buffer.concat([engineTargetContents, Buffer.from('\n')]));
        const restarted = await waitForEngineStatus(
          control,
          runningEngineProcess,
          'engine app-source restart',
          (status) => status.instanceId !== beforeEngineRestart.instanceId && readyAndSettled(status),
          signal,
        );
        await waitForSnapshot(
          runningSnapshotStream,
          'web control reconnect after engine restart',
          (snapshot) => snapshot.instanceId === restarted.instanceId && isSourceControlSettled(snapshot),
          READINESS_DEADLINE_MS,
          signal,
        );
        await writeFile(engineRuntimeTarget, Buffer.concat([engineRuntimeTargetContents, Buffer.from('\n')]));
        const dependencyRestarted = await waitForEngineStatus(
          control,
          runningEngineProcess,
          'engine runtime-dependency restart',
          (status) => status.instanceId !== restarted.instanceId && readyAndSettled(status),
          signal,
        );
        await waitForSnapshot(
          runningSnapshotStream,
          'web control reconnect after engine dependency restart',
          (snapshot) => snapshot.instanceId === dependencyRestarted.instanceId && isSourceControlSettled(snapshot),
          READINESS_DEADLINE_MS,
          signal,
        );
        await sleepWithSignal(500, signal);
        const stableStatus = await control.getStatus({ signal });
        if (stableStatus.instanceId !== dependencyRestarted.instanceId) {
          throw new Error('One engine dependency edit caused more than one engine rotation.');
        }
        await requestApplication(baseUrl, signal);
        engineRestartPreservedWebProcess = runningWebProcess.child.exitCode === null;
        if (!engineRestartPreservedWebProcess) {
          throw new Error('An engine source change restarted or stopped the Web process.');
        }
      },
      roots: () => [
        { pid: runningEngineProcess.child.pid, role: 'engine' },
        { pid: runningWebProcess.child.pid, role: 'dev' },
      ],
      temporaryDirectory,
    }),
  );
  const beforeColdIdle = await waitForEngineStatus(
    control,
    runningEngineProcess,
    'cold idle boundary',
    readyAndSettled,
  );
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: options.coldIdleMs + READINESS_DEADLINE_MS,
      devOutputDirectory,
      name: 'cold-idle',
      operation: async (signal) => {
        await sleepWithSignal(options.coldIdleMs, signal);
        const afterColdIdle = await waitForEngineStatus(
          control,
          runningEngineProcess,
          'cold idle completion',
          readyAndSettled,
          signal,
        );
        ensureSourceDidNotRun(beforeColdIdle.sourceControl, afterColdIdle.sourceControl, 'Cold idle');
        ensurePublicationDidNotAdvance(beforeColdIdle.sourceControl, afterColdIdle.sourceControl, 'Cold idle');
      },
      roots: () => [
        { pid: runningEngineProcess.child.pid, role: 'engine' },
        { pid: runningWebProcess.child.pid, role: 'dev' },
      ],
      temporaryDirectory,
    }),
  );
  const fixtureHome = environment.AI_USAGE_HOME ?? environment.HOME;
  if (!fixtureHome) {
    throw new Error('The collection delta fixture requires an isolated home.');
  }
  await addCollectionDeltaFixture(fixtureHome);
  const beforeCollection = await waitForEngineStatus(
    control,
    runningEngineProcess,
    'collection boundary',
    readyAndSettled,
  );
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: READINESS_DEADLINE_MS,
      devOutputDirectory,
      name: 'collection-publication',
      operation: async (signal) => {
        const completion = await executeUsageEngineCommandToCompletion(
          control,
          { command: 'collect-fresh-report', harness: 'codex', includeCursor: false },
          {
            expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
            signal,
            timeoutMs: READINESS_DEADLINE_MS,
          },
        );
        if (!(completion.state === 'succeeded' && completion.output.kind === 'collection')) {
          throw new Error('Measured collection completed without a collection publication.');
        }
        const expectedRevision = completion.output.publication.revision;
        if (expectedRevision === beforeCollection.currentPublication?.revision) {
          throw new Error('Measured collection did not publish the synthetic fixture delta.');
        }
        const afterCollection = await waitForEngineStatus(
          control,
          runningEngineProcess,
          'collection publication',
          (status) => readyAndSettled(status) && status.currentPublication?.revision === expectedRevision,
          signal,
        );
        const storeBoundary = await readStoreBoundarySnapshot(databasePath);
        if (storeBoundary.revision !== afterCollection.currentPublication?.revision) {
          throw new Error('SQLite and engine status disagree on the measured collection revision.');
        }
      },
      pathObservationRoot: runtimeRoot,
      roots: () => [
        { pid: runningEngineProcess.child.pid, role: 'engine' },
        { pid: runningWebProcess.child.pid, role: 'dev' },
      ],
      temporaryDirectory,
    }),
  );
  const disabledSources = await disableAutonomousSources(control, runningEngineProcess);
  const beforeWarmIdle = disabledSources.status;
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: options.warmIdleMs + READINESS_DEADLINE_MS,
      devOutputDirectory,
      name: 'warm-idle',
      operation: async (signal) => {
        await sleepWithSignal(options.warmIdleMs, signal);
        const afterWarmIdle = await waitForEngineStatus(
          control,
          runningEngineProcess,
          'warm idle completion',
          (status) =>
            readyAndSettled(status) && status.sourceControl.sources.every(({ policy }) => policy === 'disabled'),
          signal,
        );
        ensureSourceDidNotRun(beforeWarmIdle.sourceControl, afterWarmIdle.sourceControl, 'Warm idle');
        ensurePublicationDidNotAdvance(beforeWarmIdle.sourceControl, afterWarmIdle.sourceControl, 'Warm idle');
      },
      roots: () => [
        { pid: runningEngineProcess.child.pid, role: 'engine' },
        { pid: runningWebProcess.child.pid, role: 'dev' },
      ],
      temporaryDirectory,
      traceIntervalMs: WARM_IDLE_TRACE_INTERVAL_MS,
    }),
  );
  const sessionsStatus = await waitForEngineStatus(
    control,
    runningEngineProcess,
    'Sessions query boundary',
    readyAndSettled,
  );
  const sessionsRevision = sessionsStatus.currentPublication?.revision;
  if (!sessionsRevision) {
    throw new Error('Sessions query requires a current publication revision.');
  }
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: usageRuntimeSessionQueryBudgets.supervisorMs + 5 * CHILD_STOP_DEADLINE_MS,
      devOutputDirectory,
      name: 'sessions-query',
      operation: async () => {
        try {
          await runSessionQuery(
            sourceDirectory,
            {
              ...environment,
              PLAN052_BASE_URL: baseUrl,
              PLAN052_EXPECTED_REVISION: sessionsRevision,
            },
            (ownedProcess) => {
              queryProcess = ownedProcess;
              ownedProcesses.add(ownedProcess);
            },
          );
        } catch (error) {
          throw new AggregateError(
            [
              error,
              new Error(
                `Engine stderr:\n${runningEngineProcess.stderr.text()}\nWeb stdout:\n${runningWebProcess.stdout.text()}\nWeb stderr:\n${runningWebProcess.stderr.text()}`,
              ),
            ],
            'Sessions query diagnostics',
          );
        }
      },
      pollIntervalMs: QUERY_PROCESS_POLL_INTERVAL_MS,
      roots: () => [
        { pid: runningEngineProcess.child.pid, role: 'engine' },
        { pid: runningWebProcess.child.pid, role: 'dev' },
        ...(queryProcess ? [{ pid: queryProcess.child.pid, role: 'browser-action' }] : []),
      ],
      temporaryDirectory,
    }),
  );
  await restoreAutonomousSources(control, runningEngineProcess, disabledSources.enabledSourceIds);
  const beforeHmr = await waitForEngineStatus(control, runningEngineProcess, 'HMR boundary', readyAndSettled);
  const beforeHmrStore = await readStoreBoundarySnapshot(databasePath);
  const hmrTarget = path.join(webDirectory, 'src', 'dashboard-model.ts');
  const hmrTargetStat = await stat(hmrTarget);
  const hmrTargetContents = new Uint8Array(await Bun.file(hmrTarget).arrayBuffer());
  const hmrStdoutPosition = runningWebProcess.stdout.position();
  const hmrStderrPosition = runningWebProcess.stderr.position();
  try {
    scenarios.push(
      await measureScenario({
        blockDevice: options.blockDevice,
        deadlineMs: options.hmrMs + READINESS_DEADLINE_MS,
        devOutputDirectory,
        name: 'hmr',
        operation: async (signal) => {
          const startedAt = performance.now();
          await writeFile(hmrTarget, Buffer.concat([hmrTargetContents, Buffer.from('\n')]));
          while (performance.now() - startedAt < options.hmrMs) {
            const hmrLogs = `${runningWebProcess.stdout.textSince(hmrStdoutPosition)}\n${runningWebProcess.stderr.textSince(
              hmrStderrPosition,
            )}`;
            hmrMessagesDuringHmr = hmrLogs.match(HMR_MESSAGE_PATTERN)?.length ?? 0;
            if (hmrMessagesDuringHmr > 0) {
              break;
            }
            await sleepWithSignal(25, signal);
          }
          if (hmrMessagesDuringHmr === 0) {
            throw new Error('Vite did not report an HMR or reload event for the measured source change.');
          }
          const remainingDurationMs = options.hmrMs - (performance.now() - startedAt);
          if (remainingDurationMs > 0) {
            await sleepWithSignal(remainingDurationMs, signal);
          }
          const afterHmr = await waitForEngineStatus(
            control,
            runningEngineProcess,
            'HMR completion',
            readyAndSettled,
            signal,
          );
          const afterHmrStore = await readStoreBoundarySnapshot(databasePath, true);
          ensureSourceDidNotRun(beforeHmr.sourceControl, afterHmr.sourceControl, 'HMR');
          ensurePublicationDidNotAdvance(beforeHmr.sourceControl, afterHmr.sourceControl, 'HMR');
          hmrPreservedEngineInstance = beforeHmr.instanceId === afterHmr.instanceId;
          const sourceGenerationPreserved = beforeHmr.sourceControl.generation === afterHmr.sourceControl.generation;
          const currentPublicationPreserved =
            JSON.stringify(beforeHmr.currentPublication) === JSON.stringify(afterHmr.currentPublication);
          const storeGenerationsPreserved =
            JSON.stringify(beforeHmrStore.generations) === JSON.stringify(afterHmrStore.generations);
          const storeFilesPreserved = JSON.stringify(beforeHmrStore.files) === JSON.stringify(afterHmrStore.files);
          const databaseFilePreserved = beforeHmrStore.files.database === afterHmrStore.files.database;
          const walFilePreserved = beforeHmrStore.files.wal === afterHmrStore.files.wal;
          const shmFilePreserved = beforeHmrStore.files.shm === afterHmrStore.files.shm;
          hmrPreservedPublication =
            sourceGenerationPreserved &&
            currentPublicationPreserved &&
            storeGenerationsPreserved &&
            storeFilesPreserved &&
            sameStoreBoundary(beforeHmrStore, afterHmrStore);
          if (!(hmrPreservedEngineInstance && hmrPreservedPublication)) {
            throw new Error(
              `Web HMR invariant failed: engineInstance=${hmrPreservedEngineInstance} sourceGeneration=${sourceGenerationPreserved} publication=${currentPublicationPreserved} storeGenerations=${storeGenerationsPreserved} storeFiles=${storeFilesPreserved} database=${databaseFilePreserved} wal=${walFilePreserved} shm=${shmFilePreserved}.`,
            );
          }
        },
        roots: () => [
          { pid: runningEngineProcess.child.pid, role: 'engine' },
          { pid: runningWebProcess.child.pid, role: 'dev' },
        ],
        temporaryDirectory,
      }),
    );
  } finally {
    await runningSnapshotStream.close();
    snapshotStreamState.current = undefined;
    await Promise.all([stopCapturedProcess(runningWebProcess), stopCapturedProcess(runningEngineProcess)]);
    await writeFile(hmrTarget, hmrTargetContents);
    await chmod(hmrTarget, hmrTargetStat.mode % 0o1000);
    await utimes(hmrTarget, hmrTargetStat.atime, hmrTargetStat.mtime);
    await writeFile(engineTarget, engineTargetContents);
    await chmod(engineTarget, engineTargetStat.mode % 0o1000);
    await utimes(engineTarget, engineTargetStat.atime, engineTargetStat.mtime);
    await writeFile(engineRuntimeTarget, engineRuntimeTargetContents);
    await chmod(engineRuntimeTarget, engineRuntimeTargetStat.mode % 0o1000);
    await utimes(engineRuntimeTarget, engineRuntimeTargetStat.atime, engineRuntimeTargetStat.mtime);
  }
  scenarios.push(
    await measureScenario({
      blockDevice: options.blockDevice,
      deadlineMs: BUILD_DEADLINE_MS,
      devOutputDirectory,
      name: 'build-without-dev',
      operation: async () => {
        await runMeasuredBuild(sourceDirectory, environment, (ownedProcess) => {
          buildProcess = ownedProcess;
          ownedProcesses.add(ownedProcess);
        });
      },
      roots: () => (buildProcess ? [{ pid: buildProcess.child.pid, role: 'build' }] : []),
      temporaryDirectory,
      zeroBaseline: true,
    }),
  );
  const concurrentBuilds: UsageRuntimeMeasurementResult['concurrentBuilds'] = [];
  const concurrentMode = options.concurrentMode;
  for (let run = 0; run < options.concurrentRuns; run += 1) {
    concurrentBuilds.push(
      await measureConcurrentBuild(
        sourceDirectory,
        runtimeRoot,
        temporaryDirectory,
        options.blockDevice,
        concurrentMode,
        run + 1,
      ),
    );
  }
  const acceptanceBase = evaluateUsageRuntimeMeasurementAcceptance(
    [...scenarios, ...concurrentBuilds.map(({ io }) => io)],
    {
      engineRestartPreservedWebProcess,
      hmrPreservedEngineInstance,
      hmrPreservedPublication,
    },
  );
  const acceptance: UsageRuntimeMeasurementAcceptance = {
    ...acceptanceBase,
    deletedDevOutputDescriptorsAbsent:
      acceptanceBase.deletedDevOutputDescriptorsAbsent &&
      concurrentBuilds.every(({ correctness }) => correctness.peakDeletedDevOutputDescriptors === 0),
  };
  assertUsageRuntimeMeasurementAccepted(acceptance, scenarios);
  return {
    acceptance,
    blockDevice: options.blockDevice,
    clockTicksPerSecond,
    concurrentMode,
    concurrentBuilds,
    engineRestartPreservedWebProcess,
    fixture: { claudeSessions: 2, codexSessions: options.codexSessions },
    hmrMessagesDuringHmr,
    hmrPreservedEngineInstance,
    hmrPreservedPublication,
    processPollIntervalMs: PROCESS_POLL_INTERVAL_MS,
    queryProcessPollIntervalMs: QUERY_PROCESS_POLL_INTERVAL_MS,
    scenarios,
    source: {
      fingerprint: sourceIdentity.fingerprint,
      kind: options.source.kind,
      ...(sourceIdentity.revision ? { revision: sourceIdentity.revision } : {}),
    },
  };
};

export const measureUsageRuntimeIo = async (
  options: RuntimeMeasurementOptions,
): Promise<UsageRuntimeMeasurementResult> => {
  if (process.platform !== 'linux') {
    throw new Error('Usage runtime I/O measurement requires Linux /proc.');
  }
  if ((await readBlockDeviceSectors(options.blockDevice)) === undefined) {
    throw new Error(`Block device ${options.blockDevice} is absent from /proc/diskstats.`);
  }
  const runtimeRoot = await mkdtemp(RUNTIME_ROOT_PREFIX);
  await chmod(runtimeRoot, 0o700);
  const ownedProcesses = new Set<CapturedOwnedProcess>();
  const snapshotStreamState: MeasurementSnapshotStreamState = { current: undefined };
  let result: UsageRuntimeMeasurementResult | undefined;
  let operationError: unknown;
  const cleanupLifecycle = createMeasurementCleanupLifecycle(runtimeRoot, ownedProcesses, {
    clear: () => {
      snapshotStreamState.current = undefined;
    },
    current: () => snapshotStreamState.current,
  });
  cleanupLifecycle.register();

  try {
    result = await runUsageRuntimeMeasurementScenarios(options, runtimeRoot, ownedProcesses, snapshotStreamState);
  } catch (error) {
    operationError = error;
  }

  const cleanupFailures = await cleanupLifecycle.cleanup();
  const failures = [operationError, ...cleanupFailures].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Usage runtime I/O measurement failed.');
  }
  if (!result) {
    throw new Error('Usage runtime I/O measurement completed without a result.');
  }
  return result;
};

const readOption = (arguments_: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  const matching = arguments_.filter((argument) => argument.startsWith(prefix));
  if (matching.length > 1) {
    throw new Error(`Option --${name} may be provided only once.`);
  }
  return matching[0]?.slice(prefix.length);
};

const readPositiveIntegerOption = (
  arguments_: readonly string[],
  name: string,
  fallback: number,
  allowZero = false,
): number => {
  const rawValue = readOption(arguments_, name);
  if (rawValue === undefined) {
    return fallback;
  }
  const value = Number(rawValue);
  if (!(Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0))) {
    throw new Error(`Option --${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
};

export const parseRuntimeMeasurementOptions = (arguments_: readonly string[]): RuntimeMeasurementOptions => {
  const knownOptions = new Set([
    'block-device',
    'codex-sessions',
    'cold-idle-ms',
    'concurrent-mode',
    'concurrent-runs',
    'hmr-ms',
    'revision',
    'warm-idle-ms',
    'worktree',
  ]);
  for (const argument of arguments_) {
    const optionName = argument.startsWith('--') ? argument.slice(2).split('=', 1)[0] : undefined;
    if (!(optionName && knownOptions.has(optionName) && argument.includes('='))) {
      throw new Error(`Unknown measurement option: ${argument}`);
    }
  }
  const revision = readOption(arguments_, 'revision');
  const worktree = readOption(arguments_, 'worktree');
  if (revision !== undefined && worktree !== undefined) {
    throw new Error('Choose exactly one of --revision or --worktree.');
  }
  if (worktree !== undefined && worktree !== '.') {
    throw new Error('The worktree measurement target must be the current repository (.).');
  }
  const source: SourceSelection = revision
    ? { kind: 'revision', value: revision }
    : { kind: 'worktree', value: worktree ?? '.' };
  const defaultConcurrentRuns = source.kind === 'worktree' ? 3 : 1;
  const concurrentMode =
    readOption(arguments_, 'concurrent-mode') ?? (source.kind === 'worktree' ? 'isolated' : 'legacy-observation');
  if (!(concurrentMode === 'isolated' || concurrentMode === 'legacy-observation')) {
    throw new Error('Option --concurrent-mode must be isolated or legacy-observation.');
  }
  return {
    blockDevice: readOption(arguments_, 'block-device') || 'dm-0',
    codexSessions: readPositiveIntegerOption(arguments_, 'codex-sessions', 128),
    coldIdleMs: readPositiveIntegerOption(arguments_, 'cold-idle-ms', COLD_IDLE_DEFAULT_MS),
    concurrentMode,
    concurrentRuns: readPositiveIntegerOption(arguments_, 'concurrent-runs', defaultConcurrentRuns, true),
    hmrMs: readPositiveIntegerOption(arguments_, 'hmr-ms', HMR_DEFAULT_MS),
    source,
    warmIdleMs: readPositiveIntegerOption(arguments_, 'warm-idle-ms', WARM_IDLE_DEFAULT_MS),
  };
};

const errorMessages = (error: unknown): string[] => {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)];
  }
  return [error instanceof Error ? error.message : String(error)];
};

const sanitizedFailure = (error: unknown): string => {
  const repositoryDirectory = path.resolve(import.meta.dirname, '..');
  return [...new Set(errorMessages(error))]
    .join('\n')
    .replaceAll(repositoryDirectory, '<repository>')
    .replace(/\/tmp\/plan052-usage-runtime-io-[^\s/'"]+/g, '<measurement-root>');
};

if (import.meta.main) {
  let interrupted = false;
  const handleSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    try {
      const cleanupResults = await Promise.allSettled([
        interruptActiveWebBuildIsolationChecks(),
        interruptActiveUsageRuntimeMeasurements(false),
      ]);
      const cleanupFailures = cleanupResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (cleanupFailures.length === 0) {
        try {
          await removeActiveUsageRuntimeMeasurementRoots();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length > 0) {
        process.stderr.write(`${sanitizedFailure(new AggregateError(cleanupFailures, 'Signal cleanup failed.'))}\n`);
      }
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
    const result = await measureUsageRuntimeIo(parseRuntimeMeasurementOptions(Bun.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (!interrupted) {
      process.stderr.write(`${sanitizedFailure(error)}\n`);
      process.exitCode = 1;
    }
  } finally {
    if (!interrupted) {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
    }
  }
}
