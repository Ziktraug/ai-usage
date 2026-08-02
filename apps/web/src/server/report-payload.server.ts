import { parseWebUsageEngineCommand, type WebUsageEngineCommand } from '@ai-usage/usage-engine-control';
import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import type { ServedReportRevisionManifest } from '@ai-usage/usage-store/reader';
import {
  parseReportRevision,
  reportManifestRequestFingerprint,
  type WebReportRevisionBootstrapResult,
  type WebReportRevisionManifest,
  type WebReportRevisionManifestResult,
} from '../web-report-payload';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import type { UsageReadModel } from './usage-read-model.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';

const UNAVAILABLE_MESSAGE = 'Report data is unavailable.';

export const reportPerfEnabled = (): boolean =>
  process.env.AI_USAGE_PERF === '1' || process.env.AI_USAGE_PERF === 'true';

const toWebManifest = (manifest: ServedReportRevisionManifest): WebReportRevisionManifest => ({
  captureFingerprint: manifest.captureFingerprint,
  expiresAt: manifest.expiresAt,
  generatedAt: manifest.generatedAt,
  publishedAt: manifest.publishedAt,
  revision: parseReportRevision(manifest.revision),
  rowsBytes: manifest.rowsBytes,
  supportBytes: manifest.supportBytes,
});

const revisionUnavailable = (): Extract<WebReportRevisionManifestResult, { readonly ok: false }> => ({
  error: { message: UNAVAILABLE_MESSAGE, tag: 'RevisionUnavailable' },
  ok: false,
  requestFingerprint: reportManifestRequestFingerprint,
});

export const getReportRevisionManifestForServer = async (
  readModel?: Pick<UsageReadModel, 'readCurrentManifest'>,
  resolveReadModel: () => Promise<Pick<UsageReadModel, 'readCurrentManifest'>> = resolveUsageReadModelForServer,
): Promise<WebReportRevisionManifestResult> => {
  try {
    const activeReadModel = readModel ?? (await resolveReadModel());
    return {
      manifest: toWebManifest(await activeReadModel.readCurrentManifest()),
      ok: true,
      requestFingerprint: reportManifestRequestFingerprint,
    };
  } catch {
    return revisionUnavailable();
  }
};

export const getReportRevisionBootstrapForServer = async (
  readModel?: Pick<UsageReadModel, 'readCurrentBootstrap'>,
  resolveReadModel: () => Promise<Pick<UsageReadModel, 'readCurrentBootstrap'>> = resolveUsageReadModelForServer,
): Promise<WebReportRevisionBootstrapResult> => {
  try {
    const activeReadModel = readModel ?? (await resolveReadModel());
    const { manifest, support } = await activeReadModel.readCurrentBootstrap();
    return {
      bootstrap: support,
      manifest: toWebManifest(manifest),
      ok: true,
      requestFingerprint: reportManifestRequestFingerprint,
    };
  } catch {
    return revisionUnavailable();
  }
};

type ReplaceProjectGroupsByReferenceCommand = Extract<
  WebUsageEngineCommand,
  { readonly command: 'replace-project-groups-by-reference' }
>;

export const saveProjectGroupsForServer = async (
  commandValue: ReplaceProjectGroupsByReferenceCommand,
  controlValue?: UsageEngineControlClient,
  executeToCompletion: (
    control: UsageEngineControlClient,
    command: ReplaceProjectGroupsByReferenceCommand,
    options?: ExecuteUsageEngineCommandOptions,
  ) => ReturnType<typeof executeUsageEngineCommandToCompletion> = executeUsageEngineCommandToCompletion,
  options?: ExecuteUsageEngineCommandOptions,
): Promise<{ readonly accepted: boolean }> => {
  const command = parseWebUsageEngineCommand(commandValue);
  if (command.command !== 'replace-project-groups-by-reference') {
    throw new Error('Expected a path-free project group reference command.');
  }
  const control = controlValue ?? (await resolveUsageEngineControlClientForServer());
  await executeToCompletion(control, command, options);
  return { accepted: true };
};

export const saveProjectGroupsFromRequestForServer = async (
  request: Request,
  command: ReplaceProjectGroupsByReferenceCommand,
  control?: UsageEngineControlClient,
  executeToCompletion?: (
    control: UsageEngineControlClient,
    command: ReplaceProjectGroupsByReferenceCommand,
    options?: ExecuteUsageEngineCommandOptions,
  ) => ReturnType<typeof executeUsageEngineCommandToCompletion>,
): Promise<{ readonly accepted: boolean }> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await saveProjectGroupsForServer(command, control, executeToCompletion, { signal: request.signal });
};
