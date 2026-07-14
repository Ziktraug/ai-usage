import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { runConsistentStoredReportPayload, type StoredReportPayloadRequest } from '@ai-usage/report-data';
import { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from '@ai-usage/report-data/report-payload-artifact';
import { Effect } from 'effect';
import {
  type ReportRevision,
  toWebReportPayload,
  type WebReportRevisionManifest,
  type WebReportRevisionManifestResult,
} from '../web-report-payload';
import {
  createReportRevisionRegistry,
  type ReportRevisionLeaseResult,
  reportCaptureFingerprintForPayload,
} from './report-revision.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';
import { materializeSessionQueryRevision } from './session-query-materializer.server';

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { reportingPayloadRunner, rootDir, rootEnvPath } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});
const LINE_SEPARATOR = /\r?\n/;
const payloadCacheTtlMs = 10_000;
export const REVISION_RENEWAL_WINDOW_MS = 60_000;
const REPORT_RUNNER_ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_REPORT_RUNNER_STDERR_TAIL_BYTES = 64 * 1024;
const artifactCreateFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const artifactReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
let refreshState: ReportPayloadRefreshState = { runId: 0, status: 'idle' };
let refreshJob: Promise<void> | null = null;
let refreshRequestedAfterCurrent = false;
const reportRevisionRegistry = createReportRevisionRegistry({ materialize: materializeSessionQueryRevision });
const revisionPublicationByPayload = new WeakMap<UsageReportPayload, Promise<WebReportRevisionManifest>>();
const captureFingerprintByPayload = new WeakMap<UsageReportPayload, string>();
let revisionCaptureGeneration = 0;
let forcedRevisionCapturesInProgress = 0;
let lastCollectedPayload: UsageReportPayload | undefined;

export const MAX_UNCHANGED_CAPTURE_RESULT_BYTES = 64 * 1024;
const CAPTURE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

type ReportRunnerCaptureResult =
  | { captureFingerprint: string; payload: UsageReportPayload; status: 'changed'; version: 1 }
  | { captureFingerprint: string; metadata?: Record<string, unknown>; status: 'unchanged'; version: 1 };

export interface ReportPayloadCache {
  collect(options?: { force?: boolean }): Promise<UsageReportPayload>;
  invalidate(): void;
}

export interface ReportPayloadCacheOptions {
  load(options: { force?: boolean }): Promise<UsageReportPayload>;
  now?: () => number;
  ttlMs?: number;
}

export const createReportPayloadCache = ({
  load,
  now = Date.now,
  ttlMs = payloadCacheTtlMs,
}: ReportPayloadCacheOptions): ReportPayloadCache => {
  let generation = 0;
  let cachedPayload: { payload: UsageReportPayload; storedAt: number } | null = null;
  let inFlightPayload: { generation: number; id: symbol; promise: Promise<UsageReportPayload> } | null = null;
  let serveStaleAfterRefreshFailure = false;

  const invalidate = () => {
    generation++;
    cachedPayload = null;
    inFlightPayload = null;
    serveStaleAfterRefreshFailure = false;
  };

  const collect = (options: { force?: boolean } = {}) => {
    if (options.force) {
      generation++;
      inFlightPayload = null;
    }

    const requestedAt = now();
    if (
      !options.force &&
      cachedPayload &&
      (requestedAt - cachedPayload.storedAt < ttlMs || serveStaleAfterRefreshFailure)
    ) {
      return Promise.resolve(cachedPayload.payload);
    }

    if (!options.force && inFlightPayload?.generation === generation) {
      if (cachedPayload) {
        return Promise.resolve(cachedPayload.payload);
      }
      return inFlightPayload.promise;
    }

    const requestGeneration = generation;
    const requestId = Symbol('report-payload-request');
    const request = (async () => {
      // Defer execution until `request` and `inFlightPayload` both reference
      // this run, including when a loader throws synchronously.
      await Promise.resolve();
      try {
        const payload = await load(options);
        if (generation === requestGeneration) {
          cachedPayload = { payload, storedAt: now() };
          serveStaleAfterRefreshFailure = false;
        }
        return payload;
      } catch (error) {
        if (options.force && generation === requestGeneration && cachedPayload) {
          serveStaleAfterRefreshFailure = true;
        }
        throw error;
      } finally {
        if (inFlightPayload?.id === requestId) {
          inFlightPayload = null;
        }
      }
    })();
    inFlightPayload = { generation: requestGeneration, id: requestId, promise: request };
    return request;
  };

  return { collect, invalidate };
};

export type ReportPayloadRefreshState =
  | { runId: number; status: 'idle' }
  | { runId: number; startedAt: number; status: 'running' }
  | { completedAt: number; runId: number; startedAt: number; status: 'completed' }
  | { error: string; failedAt: number; runId: number; startedAt: number; status: 'failed' };

const readRootEnvValue = (key: string) => {
  try {
    if (!fs.existsSync(rootEnvPath)) {
      return;
    }
    const line = fs
      .readFileSync(rootEnvPath, 'utf8')
      .split(LINE_SEPARATOR)
      .find((entry) => entry.trim().startsWith(`${key}=`));
    if (!line) {
      return;
    }
    return line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  } catch {
    return;
  }
};

const perfEnvValue = () => process.env.AI_USAGE_PERF ?? readRootEnvValue('AI_USAGE_PERF');
const perfEnabled = () => perfEnvValue() === '1' || perfEnvValue() === 'true';

export const reportPerfEnabled = () => perfEnabled();

export const saveProjectGroupsForServer = async (projectGroups: ProjectGroupConfig[]) => {
  const validatedProjectGroups = parseProjectGroupConfigs(projectGroups);
  const storage = createLocalHistoryStorage();
  await Effect.runPromise(
    updateAiUsageConfig((config) => ({ ...config, projectGroups: validatedProjectGroups })).pipe(
      Effect.provideService(LocalHistoryStorage, storage),
    ),
  );
  await invalidateReportPayloadForMutation({ scheduleRefresh: true });
  return { projectGroups: validatedProjectGroups };
};

const payloadModeFromOptions = (options: { force?: boolean }) => (options.force ? 'fresh' : 'stored');
const isBunRuntime = () => Boolean((process.versions as unknown as Record<string, string | undefined>).bun);

const payloadRequest = (): StoredReportPayloadRequest => ({
  harness: null,
  includeCursor: true,
  configCwd: rootDir,
  includeFacets: true,
  options: {
    since: null,
    project: null,
    limit: null,
    minTokens: 1,
    sort: 'date',
  },
});

const withRootPerfEnv = async <A>(run: () => Promise<A>) => {
  const rootPerfValue = perfEnvValue();
  const previousPerfValue = process.env.AI_USAGE_PERF;
  if (rootPerfValue) {
    process.env.AI_USAGE_PERF = rootPerfValue;
  }

  try {
    return await run();
  } finally {
    if (previousPerfValue === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfValue;
    }
  }
};

const loadStoredPayloadDirect = async (): Promise<UsageReportPayload> => {
  const startedAt = Date.now();
  try {
    const payload = await withRootPerfEnv(() => runConsistentStoredReportPayload(payloadRequest()));
    if (perfEnabled()) {
      console.error(
        `[perf] aiUsage.web.reportPayloadDirect ok mode=stored durationMs=${Date.now() - startedAt} rows=${payload.rows.length}`,
      );
    }
    return payload;
  } catch (error) {
    if (perfEnabled()) {
      console.error(`[perf] aiUsage.web.reportPayloadDirect failed mode=stored durationMs=${Date.now() - startedAt}`);
    }
    throw error;
  }
};

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const appendBoundedTail = (tail: Buffer, chunk: Buffer, maximumBytes: number): Buffer => {
  if (chunk.byteLength >= maximumBytes) {
    return Buffer.from(chunk.subarray(chunk.byteLength - maximumBytes));
  }
  const combinedLength = tail.byteLength + chunk.byteLength;
  if (combinedLength <= maximumBytes) {
    return Buffer.concat([tail, chunk], combinedLength);
  }
  const bytesToKeepFromTail = maximumBytes - chunk.byteLength;
  return Buffer.concat([tail.subarray(tail.byteLength - bytesToKeepFromTail), chunk], maximumBytes);
};

export class ReportPayloadRunnerProcessError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail: Buffer) {
    const decodedTail = stderrTail.toString('utf8');
    super(decodedTail.trim() ? `${message}: ${decodedTail.trim()}` : message);
    this.name = 'ReportPayloadRunnerProcessError';
    this.stderrTail = decodedTail;
  }
}

const readReportPayloadArtifact = async (artifactPath: string): Promise<{ bytes: number; payload: string }> => {
  const artifact = await open(artifactPath, artifactReadFlags);
  try {
    const artifactStat = await artifact.stat();
    const isPrivateRegularFile = artifactStat.isFile() && hasOwnerOnlyPermissions(artifactStat.mode);
    if (!(isPrivateRegularFile && isOwnedByCurrentUser(artifactStat.uid))) {
      throw new Error('Report payload artifact must be a private regular file owned by the current user');
    }
    if (artifactStat.size > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report payload artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      const remainingBytes = MAX_REPORT_RUNNER_ARTIFACT_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(REPORT_RUNNER_ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await artifact.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Report payload artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }

    const serializedPayload = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return { bytes: totalBytes, payload: serializedPayload };
  } finally {
    await artifact.close();
  }
};

export interface ReportPayloadArtifactProcessOptions {
  args: readonly string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  temporaryDirectoryParent?: string;
  validate?: (serializedPayload: string) => void;
}

export interface ReportPayloadArtifactProcessResult {
  artifactBytes: number;
  serializedPayload: string;
  stderrTail: string;
}

export const runReportPayloadArtifactProcess = async ({
  args,
  command,
  cwd,
  env,
  signal,
  temporaryDirectoryParent = tmpdir(),
  validate,
}: ReportPayloadArtifactProcessOptions): Promise<ReportPayloadArtifactProcessResult> => {
  let artifactDirectory: string | undefined;
  try {
    artifactDirectory = await mkdtemp(path.join(temporaryDirectoryParent, 'ai-usage-report-payload-'));
    await chmod(artifactDirectory, 0o700);
    const artifactPath = path.join(artifactDirectory, 'payload.json');
    const artifact = await open(artifactPath, artifactCreateFlags, 0o600);
    await artifact.close();
    await chmod(artifactPath, 0o600);

    const child = spawn(command, [...args, artifactPath], {
      cwd,
      ...(env === undefined ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail: Buffer = Buffer.alloc(0);
    child.stdout.on('data', () => {
      // The protocol uses the private artifact. Drain accidental output without
      // retaining it so a noisy child cannot recreate the old stdout ceiling.
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stderrTail = appendBoundedTail(stderrTail, chunkBuffer, MAX_REPORT_RUNNER_STDERR_TAIL_BYTES);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      child.once('error', (error) => {
        rejectOnce(new ReportPayloadRunnerProcessError(error.message, stderrTail));
      });
      child.once('close', (code, childSignal) => {
        if (settled) {
          return;
        }
        settled = true;
        if (code === 0) {
          resolve();
          return;
        }
        const exitDescription = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`;
        reject(new ReportPayloadRunnerProcessError(`Report payload runner exited with ${exitDescription}`, stderrTail));
      });
    });

    const { bytes, payload } = await readReportPayloadArtifact(artifactPath);
    validate?.(payload);
    return { artifactBytes: bytes, serializedPayload: payload, stderrTail: stderrTail.toString('utf8') };
  } finally {
    if (artifactDirectory !== undefined) {
      await rm(artifactDirectory, { force: true, recursive: true });
    }
  }
};

export const runReportPayloadRunner = async (options: { force?: boolean; signal?: AbortSignal } = {}) => {
  const startedAt = Date.now();
  const mode = payloadModeFromOptions(options);
  const env = {
    ...process.env,
    ...(perfEnvValue() ? { AI_USAGE_PERF: perfEnvValue() } : {}),
  };

  try {
    const current = options.force ? await reportRevisionRegistry.getCurrentManifest() : undefined;
    const currentCaptureFingerprint = current?.ok ? current.manifest.captureFingerprint : '';
    const result = await runReportPayloadArtifactProcess({
      args: [reportingPayloadRunner, mode, rootDir, currentCaptureFingerprint],
      command: 'bun',
      cwd: rootDir,
      env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      validate: (serializedPayload) => {
        parseRunnerCaptureResult(serializedPayload);
      },
    });
    if (perfEnabled()) {
      if (result.stderrTail.trim()) {
        console.error(result.stderrTail.trimEnd());
      }
      console.error(
        `[perf] aiUsage.web.reportPayloadRunner ok mode=${mode} durationMs=${Date.now() - startedAt} bytes=${result.artifactBytes}`,
      );
    }
    return result.serializedPayload;
  } catch (error) {
    const stderr = error instanceof ReportPayloadRunnerProcessError ? error.stderrTail : '';
    if (perfEnabled()) {
      if (stderr.trim()) {
        console.error(stderr.trimEnd());
      }
      console.error(`[perf] aiUsage.web.reportPayloadRunner failed mode=${mode} durationMs=${Date.now() - startedAt}`);
    }
    throw error;
  }
};

export const parseRunnerPayload = (stdout: string): UsageReportPayload => {
  const parsed = parseJsonRunnerOutput(stdout);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (Object.hasOwn(parsed, 'status') || Object.hasOwn(parsed, 'version'))
  ) {
    const result = parseRunnerCaptureResult(stdout);
    if (result.status === 'unchanged') {
      throw new Error('Unchanged report capture does not contain a payload');
    }
    return result.payload;
  }
  return parsed as UsageReportPayload;
};

const parseJsonRunnerOutput = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const jsonStart = stdout.lastIndexOf('\n{');
    if (jsonStart >= 0) {
      return JSON.parse(stdout.slice(jsonStart + 1)) as unknown;
    }
    throw error;
  }
};

export const parseRunnerCaptureResult = (serialized: string): ReportRunnerCaptureResult => {
  const value = parseJsonRunnerOutput(serialized);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Report capture result must be an object');
  }
  const result = value as Record<string, unknown>;
  const validFingerprint =
    typeof result.captureFingerprint === 'string' && CAPTURE_FINGERPRINT_PATTERN.test(result.captureFingerprint);
  if (result.version !== 1 || !validFingerprint || (result.status !== 'changed' && result.status !== 'unchanged')) {
    throw new Error('Report capture result is malformed');
  }
  if (result.status === 'unchanged') {
    if (Buffer.byteLength(serialized) > MAX_UNCHANGED_CAPTURE_RESULT_BYTES) {
      throw new Error(`Unchanged report capture result exceeds the ${MAX_UNCHANGED_CAPTURE_RESULT_BYTES}-byte limit`);
    }
    const keys = Object.keys(result).sort().join(',');
    if (keys !== 'captureFingerprint,status,version' && keys !== 'captureFingerprint,metadata,status,version') {
      throw new Error('Unchanged report capture result contains unknown fields');
    }
    if (
      result.metadata !== undefined &&
      (typeof result.metadata !== 'object' || result.metadata === null || Array.isArray(result.metadata))
    ) {
      throw new Error('Unchanged report capture metadata must be an object');
    }
    return {
      captureFingerprint: result.captureFingerprint as string,
      ...(result.metadata === undefined ? {} : { metadata: result.metadata as Record<string, unknown> }),
      status: 'unchanged',
      version: 1,
    };
  }
  if (Object.keys(result).sort().join(',') !== 'captureFingerprint,payload,status,version') {
    throw new Error('Changed report capture result contains unknown fields');
  }
  const payload = result.payload as Partial<UsageReportPayload> | undefined;
  if (!(payload && Array.isArray(payload.rows) && typeof payload.generatedAt === 'string')) {
    throw new Error('Changed report capture result payload is malformed');
  }
  return {
    captureFingerprint: result.captureFingerprint as string,
    payload: payload as UsageReportPayload,
    status: 'changed',
    version: 1,
  };
};

const formatRefreshError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const getReportPayloadRefreshState = () => refreshState;

export const startReportPayloadRefresh = () => {
  if (refreshJob && refreshState.status === 'running') {
    if (perfEnabled()) {
      console.error(`[perf] aiUsage.web.reportPayloadRefresh join runId=${refreshState.runId}`);
    }
    return refreshState;
  }

  const runId = refreshState.runId + 1;
  const startedAt = Date.now();
  refreshState = { runId, startedAt, status: 'running' };
  if (perfEnabled()) {
    console.error(`[perf] aiUsage.web.reportPayloadRefresh started runId=${runId}`);
  }

  refreshJob = (async () => {
    try {
      const payload = await runReportPayloadCollection({ force: true });
      refreshState = { completedAt: Date.now(), runId, startedAt, status: 'completed' };
      if (perfEnabled()) {
        console.error(
          `[perf] aiUsage.web.reportPayloadRefresh completed runId=${runId} durationMs=${Date.now() - startedAt} rows=${payload.rows.length}`,
        );
      }
    } catch (error) {
      refreshState = { error: formatRefreshError(error), failedAt: Date.now(), runId, startedAt, status: 'failed' };
      if (perfEnabled()) {
        console.error(
          `[perf] aiUsage.web.reportPayloadRefresh failed runId=${runId} durationMs=${Date.now() - startedAt}`,
        );
      }
    } finally {
      refreshJob = null;
      if (refreshRequestedAfterCurrent) {
        refreshRequestedAfterCurrent = false;
        startReportPayloadRefresh();
      }
    }
  })();

  return refreshState;
};

const loadPayload = async (options: { force?: boolean }): Promise<UsageReportPayload> => {
  if (!options.force && isBunRuntime()) {
    return await loadStoredPayloadDirect();
  }
  const result = parseRunnerCaptureResult(await runReportPayloadRunner(options));
  if (result.status === 'changed') {
    captureFingerprintByPayload.set(result.payload, result.captureFingerprint);
    return result.payload;
  }
  const payload = lastCollectedPayload ?? (await loadStoredPayloadDirect());
  captureFingerprintByPayload.set(payload, result.captureFingerprint);
  return payload;
};

const loadPayloadWithFreshFallback = async (options: { force?: boolean }) => {
  const payload = await loadPayload(options);
  if (!options.force && payload.rows.length === 0) {
    if (perfEnabled()) {
      console.error('[perf] aiUsage.web.reportPayloadCache stored-empty-fallback');
    }
    return await loadPayload({ force: true });
  }
  return payload;
};

const reportPayloadCache = createReportPayloadCache({ load: loadPayloadWithFreshFallback });

const ensurePublishedRevision = async (payload: UsageReportPayload): Promise<WebReportRevisionManifest> => {
  const existingPublication = revisionPublicationByPayload.get(payload);
  if (existingPublication) {
    const manifest = await existingPublication;
    const current = await reportRevisionRegistry.getCurrentManifest();
    if (current.ok && current.manifest.revision === manifest.revision) {
      return manifest;
    }
  }

  const webPayload = toWebReportPayload(payload);
  const captureFingerprint = captureFingerprintByPayload.get(payload) ?? reportCaptureFingerprintForPayload(webPayload);
  const current = await reportRevisionRegistry.getCurrentManifest();
  if (current.ok && current.manifest.captureFingerprint === captureFingerprint) {
    let manifest = current.manifest;
    if (current.manifest.expiresAt - Date.now() <= REVISION_RENEWAL_WINDOW_MS) {
      const renewal = await reportRevisionRegistry.renewCurrent();
      if (renewal.ok) {
        manifest = renewal.manifest;
      }
    }
    revisionPublicationByPayload.set(payload, Promise.resolve(manifest));
    return manifest;
  }

  const publication = reportRevisionRegistry.publish(webPayload, { captureFingerprint });
  revisionPublicationByPayload.set(payload, publication);
  try {
    return await publication;
  } catch (error) {
    if (revisionPublicationByPayload.get(payload) === publication) {
      revisionPublicationByPayload.delete(payload);
    }
    throw error;
  }
};

export const runReportPayloadCollection = async (options: { force?: boolean } = {}): Promise<UsageReportPayload> => {
  if (options.force && refreshJob && refreshState.status === 'running') {
    await refreshJob;
    return await runReportPayloadCollection();
  }
  const captureGeneration = options.force ? ++revisionCaptureGeneration : revisionCaptureGeneration;
  if (options.force) {
    forcedRevisionCapturesInProgress++;
  }
  try {
    const payload = await reportPayloadCache.collect(options);
    const noNewerCaptureExists = captureGeneration === revisionCaptureGeneration;
    const canPublishStoredCapture = options.force || forcedRevisionCapturesInProgress === 0;
    if (noNewerCaptureExists && canPublishStoredCapture) {
      await ensurePublishedRevision(payload);
      lastCollectedPayload = payload;
    }
    return payload;
  } finally {
    if (options.force) {
      forcedRevisionCapturesInProgress--;
    }
  }
};

export const getReportRevisionManifestForServer = async (): Promise<WebReportRevisionManifestResult> => {
  const current = await reportRevisionRegistry.getCurrentManifest();
  if (current.ok) {
    return current;
  }
  await runReportPayloadCollection();
  return await reportRevisionRegistry.getCurrentManifest();
};

export const withReportRevisionDirectoryForServer = <Result>(
  revision: ReportRevision,
  operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
): Promise<ReportRevisionLeaseResult<Result>> => reportRevisionRegistry.withRevisionDirectory(revision, operation);

export const invalidateReportPayloadForMutation = async (
  options: { scheduleRefresh?: boolean } = {},
): Promise<void> => {
  revisionCaptureGeneration++;
  reportPayloadCache.invalidate();
  await reportRevisionRegistry.invalidateLatest();
  if (options.scheduleRefresh) {
    if (refreshJob && refreshState.status === 'running') {
      refreshRequestedAfterCurrent = true;
    } else {
      startReportPayloadRefresh();
    }
  }
};
