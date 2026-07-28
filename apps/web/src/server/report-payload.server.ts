import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { readAiUsageConfig, updateAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import {
  type CampaignLabelOverride,
  type CampaignLabelOverrideMutation,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import {
  runConsistentStoredReportCapture,
  type StoredReportCapture,
  type StoredReportPayloadRequest,
} from '@ai-usage/report-data';
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
const INITIAL_PUBLICATION_WAIT_MS = 2000;
const PUBLICATION_POLL_INTERVAL_MS = 25;
export const REVISION_RENEWAL_WINDOW_MS = 60_000;
type ReportRevisionRegistry = ReturnType<typeof createReportRevisionRegistry>;

export interface EnsurePublishedRevisionDependencies {
  now(): number;
  publications: WeakMap<UsageReportPayload, Promise<WebReportRevisionManifest>>;
  registry: ReportRevisionRegistry;
}

export interface GetReportRevisionManifestDependencies {
  now(): number;
  readCurrent(): Promise<WebReportRevisionManifestResult>;
  requestPublication(): Promise<boolean>;
  wait(milliseconds: number): Promise<void>;
}

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

export const getCampaignLabelOverridesForServer = async (
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const config = await Effect.runPromise(readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  return { campaignLabelOverrides: parseCampaignLabelOverrides(config.campaignLabelOverrides ?? []) };
};

export const setCampaignLabelOverrideForServer = async (
  input: CampaignLabelOverrideMutation,
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const mutation = parseCampaignLabelOverrideMutation(input);
  const config = await Effect.runPromise(
    updateAiUsageConfig((currentConfig) => {
      const currentOverrides = parseCampaignLabelOverrides(currentConfig.campaignLabelOverrides ?? []);
      const existingIndex = currentOverrides.findIndex(({ campaignKey }) => campaignKey === mutation.campaignKey);
      let nextOverrides: CampaignLabelOverride[];
      if (mutation.label === null) {
        nextOverrides = currentOverrides.filter(({ campaignKey }) => campaignKey !== mutation.campaignKey);
      } else if (existingIndex >= 0) {
        nextOverrides = [...currentOverrides];
        nextOverrides[existingIndex] = { campaignKey: mutation.campaignKey, label: mutation.label };
      } else {
        nextOverrides = [...currentOverrides, { campaignKey: mutation.campaignKey, label: mutation.label }];
      }

      const validatedOverrides = parseCampaignLabelOverrides(nextOverrides);
      if (validatedOverrides.length === 0) {
        const { campaignLabelOverrides: _campaignLabelOverrides, ...rest } = currentConfig;
        return rest;
      }
      return { ...currentConfig, campaignLabelOverrides: validatedOverrides };
    }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
  );
  return { campaignLabelOverrides: parseCampaignLabelOverrides(config.campaignLabelOverrides ?? []) };
};

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

const loadStoredPayloadDirect = async (): Promise<StoredReportCapture> =>
  withRootPerfEnv(() => runConsistentStoredReportCapture(payloadRequest()));

export const ensurePublishedRevision = async (
  capture: StoredReportCapture,
  dependencies: EnsurePublishedRevisionDependencies = {
    now: Date.now,
    publications: revisionPublicationByPayload,
    registry: reportRevisionRegistry,
  },
): Promise<WebReportRevisionManifest> => {
  const { machineFreshness, payload, rowSourceAuthorities } = capture;
  const { now, publications, registry } = dependencies;
  const webPayload = { ...toWebReportPayload(payload), machineFreshness };
  const privateCaptureFingerprint = reportCaptureFingerprintForPayload(webPayload, rowSourceAuthorities);
  const existingPublication = publications.get(payload);
  if (existingPublication) {
    const manifest = await existingPublication;
    const current = await registry.getCurrentManifestForCapture(privateCaptureFingerprint);
    if (current.ok && current.manifest.revision === manifest.revision) {
      return manifest;
    }
  }

  const current = await registry.getCurrentManifestForCapture(privateCaptureFingerprint);
  if (current.ok) {
    if (current.manifest.expiresAt - now() > REVISION_RENEWAL_WINDOW_MS) {
      publications.set(payload, Promise.resolve(current.manifest));
      return current.manifest;
    }
    const renewal = await registry.renewCurrentForCapture(current.manifest.revision, privateCaptureFingerprint);
    if (renewal.ok) {
      publications.set(payload, Promise.resolve(renewal.manifest));
      return renewal.manifest;
    }
    const rematched = await registry.getCurrentManifestForCapture(privateCaptureFingerprint);
    if (rematched.ok) {
      publications.set(payload, Promise.resolve(rematched.manifest));
      return rematched.manifest;
    }
  }

  const publication = registry.publish(webPayload, { rowSourceAuthorities });
  publications.set(payload, publication);
  try {
    return await publication;
  } catch (error) {
    if (publications.get(payload) === publication) {
      publications.delete(payload);
    }
    throw error;
  }
};

export const publishStoredReportRevisionForSourceControl = async (): Promise<{
  changed: boolean;
  revision: string;
}> => {
  const previous = await reportRevisionRegistry.getCurrentManifest();
  const capture = await loadStoredPayloadDirect();
  const manifest = await ensurePublishedRevision(capture);
  return {
    changed: !(previous.ok && previous.manifest.revision === manifest.revision),
    revision: manifest.revision,
  };
};

export const getReportRevisionManifestForServer = async (
  dependencies: GetReportRevisionManifestDependencies = {
    now: Date.now,
    readCurrent: () => reportRevisionRegistry.getCurrentManifest(),
    requestPublication: requestSourceControlPublicationForServer,
    wait: delay,
  },
): Promise<WebReportRevisionManifestResult> => {
  const { now, readCurrent, requestPublication, wait } = dependencies;
  const current = await readCurrent();
  if (current.ok) {
    return current;
  }
  const publicationRequested = await requestPublication();
  if (!publicationRequested) {
    return current;
  }

  const deadline = now() + INITIAL_PUBLICATION_WAIT_MS;
  let latest: WebReportRevisionManifestResult = current;
  while (now() < deadline) {
    await wait(PUBLICATION_POLL_INTERVAL_MS);
    latest = await readCurrent();
    if (latest.ok) {
      return latest;
    }
  }
  return latest;
};

export const withReportRevisionQueryLeaseForServer = <Result>(
  revision: ReportRevision,
  operation: (directory: string, manifest: WebReportRevisionManifest) => Promise<Result>,
): Promise<ReportRevisionLeaseResult<Result>> => reportRevisionRegistry.withSessionQueryLease(revision, operation);

export const invalidateReportPayloadForMutation = async (
  options: { scheduleRefresh?: boolean } = {},
): Promise<void> => {
  await reportRevisionRegistry.invalidateLatest();
  if (options.scheduleRefresh) {
    await requestSourceControlPublicationForServer();
  }
};
