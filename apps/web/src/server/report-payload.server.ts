import fs from 'node:fs';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { runConsistentStoredReportPayload, type StoredReportPayloadRequest } from '@ai-usage/report-data';
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
import { requestSourceControlPublicationForServer } from './source-control.server';

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { rootDir, rootEnvPath } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});
const LINE_SEPARATOR = /\r?\n/;
export const REVISION_RENEWAL_WINDOW_MS = 60_000;
type ReportRevisionRegistry = ReturnType<typeof createReportRevisionRegistry>;

const reportPublicationState = globalThis as typeof globalThis & {
  __aiUsageReportPublicationState:
    | {
        publications: WeakMap<UsageReportPayload, Promise<WebReportRevisionManifest>>;
        registry: ReportRevisionRegistry;
      }
    | undefined;
};
reportPublicationState.__aiUsageReportPublicationState ??= {
  publications: new WeakMap(),
  registry: createReportRevisionRegistry({ materialize: materializeSessionQueryRevision }),
};
const reportRevisionRegistry = reportPublicationState.__aiUsageReportPublicationState.registry;
const revisionPublicationByPayload = reportPublicationState.__aiUsageReportPublicationState.publications;

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
  const captureFingerprint = reportCaptureFingerprintForPayload(webPayload);
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

export const publishStoredReportRevisionForSourceControl = async (): Promise<{
  changed: boolean;
  revision: string;
}> => {
  const previous = await reportRevisionRegistry.getCurrentManifest();
  const payload = await loadStoredPayloadDirect();
  const manifest = await ensurePublishedRevision(payload);
  return {
    changed: !(previous.ok && previous.manifest.revision === manifest.revision),
    revision: manifest.revision,
  };
};

export const getReportRevisionManifestForServer = async (): Promise<WebReportRevisionManifestResult> => {
  const current = await reportRevisionRegistry.getCurrentManifest();
  if (current.ok) {
    return current;
  }
  await requestSourceControlPublicationForServer();
  return current;
};

export const withReportRevisionDirectoryForServer = <Result>(
  revision: ReportRevision,
  operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
): Promise<ReportRevisionLeaseResult<Result>> => reportRevisionRegistry.withRevisionDirectory(revision, operation);

export const invalidateReportPayloadForMutation = async (
  options: { scheduleRefresh?: boolean } = {},
): Promise<void> => {
  await reportRevisionRegistry.invalidateLatest();
  if (options.scheduleRefresh) {
    await requestSourceControlPublicationForServer();
  }
};
