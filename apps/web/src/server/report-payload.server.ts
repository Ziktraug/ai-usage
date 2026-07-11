import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { runStoredReportPayload, type StoredReportPayloadRequest } from '@ai-usage/report-data';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportingPayloadRunner = path.join(rootDir, 'packages/report-data/src/report-payload-runner.ts');
const execFileAsync = promisify(execFile);
const rootEnvPath = path.join(rootDir, '.env');
const userConfigPath = path.join(os.homedir(), '.config', 'ai-usage', 'config.json');
const LINE_SEPARATOR = /\r?\n/;
const payloadCacheTtlMs = 10_000;
let cachedPayload: { payload: UsageReportPayload; storedAt: number } | null = null;
let inFlightPayload: Promise<UsageReportPayload> | null = null;
let refreshState: ReportPayloadRefreshState = { runId: 0, status: 'idle' };
let refreshJob: Promise<void> | null = null;

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

export const saveProjectGroupsForServer = (projectGroups: ProjectGroupConfig[]) => {
  const validatedProjectGroups = parseProjectGroupConfigs(projectGroups);
  const config = fs.existsSync(userConfigPath)
    ? (JSON.parse(fs.readFileSync(userConfigPath, 'utf8')) as AiUsageConfig)
    : {};
  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
  fs.writeFileSync(
    userConfigPath,
    `${JSON.stringify({ ...config, projectGroups: validatedProjectGroups }, null, 2)}\n`,
    'utf8',
  );
  cachedPayload = null;
  inFlightPayload = null;
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

  refreshJob = loadFreshPayload()
    .then((payload) => {
      cachedPayload = { payload, storedAt: Date.now() };
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

export const runReportPayloadCollection = async (options: { force?: boolean } = {}): Promise<UsageReportPayload> => {
  const now = Date.now();
  if (!options.force && cachedPayload && now - cachedPayload.storedAt < payloadCacheTtlMs) {
    if (perfEnabled()) {
      console.error(`[perf] aiUsage.web.reportPayloadCache hit ageMs=${now - cachedPayload.storedAt}`);
    }
    return cachedPayload.payload;
  }

  if (!options.force && inFlightPayload) {
    if (perfEnabled()) {
      console.error('[perf] aiUsage.web.reportPayloadCache join');
    }
    return inFlightPayload;
  }

  inFlightPayload = loadPayload(options)
    .then((payload) => {
      if (!options.force && payload.rows.length === 0) {
        if (perfEnabled()) {
          console.error('[perf] aiUsage.web.reportPayloadCache stored-empty-fallback');
        }
        return loadFreshPayload();
      }
      return payload;
    })
    .then((payload) => {
      cachedPayload = { payload, storedAt: Date.now() };
      return payload;
    })
    .finally(() => {
      inFlightPayload = null;
    });

  return await inFlightPayload;
};
