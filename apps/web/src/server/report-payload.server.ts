import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { runStoredReportPayload, type StoredReportPayloadRequest } from '@ai-usage/report-data';
import { Effect } from 'effect';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportingPayloadRunner = path.join(rootDir, 'packages/report-data/src/report-payload-runner.ts');
const execFileAsync = promisify(execFile);
const rootEnvPath = path.join(rootDir, '.env');
const LINE_SEPARATOR = /\r?\n/;
const payloadCacheTtlMs = 10_000;
let refreshState: ReportPayloadRefreshState = { runId: 0, status: 'idle' };
let refreshJob: Promise<void> | null = null;

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
  reportPayloadCache.invalidate();
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
    const payload = await withRootPerfEnv(() => runStoredReportPayload(payloadRequest()));
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

export const runReportPayloadRunner = async (options: { force?: boolean } = {}) => {
  const startedAt = Date.now();
  const mode = payloadModeFromOptions(options);
  const env = {
    ...process.env,
    ...(perfEnvValue() ? { AI_USAGE_PERF: perfEnvValue() } : {}),
  };

  try {
    const { stderr, stdout } = await execFileAsync('bun', [reportingPayloadRunner, mode, rootDir], {
      cwd: rootDir,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (perfEnabled()) {
      if (stderr.trim()) {
        console.error(stderr.trimEnd());
      }
      console.error(
        `[perf] aiUsage.web.reportPayloadRunner ok mode=${mode} durationMs=${Date.now() - startedAt} bytes=${stdout.length}`,
      );
    }
    return stdout;
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
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
  try {
    return JSON.parse(stdout) as UsageReportPayload;
  } catch (error) {
    const jsonStart = stdout.lastIndexOf('\n{');
    if (jsonStart >= 0) {
      return JSON.parse(stdout.slice(jsonStart + 1)) as UsageReportPayload;
    }
    throw error;
  }
};

const loadFreshPayload = () => runReportPayloadRunner({ force: true }).then(parseRunnerPayload);

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

  refreshJob = reportPayloadCache
    .collect({ force: true })
    .then((payload) => {
      refreshState = { completedAt: Date.now(), runId, startedAt, status: 'completed' };
      if (perfEnabled()) {
        console.error(
          `[perf] aiUsage.web.reportPayloadRefresh completed runId=${runId} durationMs=${Date.now() - startedAt} rows=${payload.rows.length}`,
        );
      }
    })
    .catch((error: unknown) => {
      refreshState = { error: formatRefreshError(error), failedAt: Date.now(), runId, startedAt, status: 'failed' };
      if (perfEnabled()) {
        console.error(
          `[perf] aiUsage.web.reportPayloadRefresh failed runId=${runId} durationMs=${Date.now() - startedAt}`,
        );
      }
    })
    .finally(() => {
      refreshJob = null;
    });

  return refreshState;
};

const loadPayload = (options: { force?: boolean }) => {
  if (!options.force && isBunRuntime()) {
    return loadStoredPayloadDirect();
  }
  return runReportPayloadRunner(options).then(parseRunnerPayload);
};

const loadPayloadWithFreshFallback = async (options: { force?: boolean }) => {
  const payload = await loadPayload(options);
  if (!options.force && payload.rows.length === 0) {
    if (perfEnabled()) {
      console.error('[perf] aiUsage.web.reportPayloadCache stored-empty-fallback');
    }
    return await loadFreshPayload();
  }
  return payload;
};

const reportPayloadCache = createReportPayloadCache({ load: loadPayloadWithFreshFallback });

export const runReportPayloadCollection = (options: { force?: boolean } = {}): Promise<UsageReportPayload> =>
  reportPayloadCache.collect(options);
