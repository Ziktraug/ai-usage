import { serializeUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { QueryUsageSyncFleetResult, UsageStoreErrorReason } from '@ai-usage/usage-store/reader';
import type { ManualOperationResult } from '../manual-transfer-contract';
import type { UsageReadModel } from './usage-read-model.server';

export interface ManualMergeExportResult {
  readonly bytes: number;
  readonly filename: string;
  readonly machine: UsageMachine;
  readonly rows: number;
  readonly text: string;
}

const usageStoreReasons = new Set<UsageStoreErrorReason>([
  'busy',
  'corrupt',
  'invalid-input',
  'machine-unavailable',
  'migration-failure',
  'preview-stale',
  'preview-unavailable',
  'revision-expired',
  'revision-unavailable',
  'schema-too-new',
  'schema-too-old',
  'self-import',
  'storage-failure',
  'store-missing',
]);

const usageStoreReason = (error: unknown): UsageStoreErrorReason | undefined => {
  if (!(typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string')) {
    return;
  }
  return usageStoreReasons.has(error.reason as UsageStoreErrorReason)
    ? (error.reason as UsageStoreErrorReason)
    : undefined;
};

const usageStoreFailureMessage = (reason: UsageStoreErrorReason | undefined): string => {
  if (reason === 'store-missing' || reason === 'machine-unavailable' || reason === 'revision-unavailable') {
    return 'No durable usage data is available yet.';
  }
  if (reason === 'schema-too-new' || reason === 'schema-too-old' || reason === 'migration-failure') {
    return 'Stored usage data is incompatible with this web app.';
  }
  if (reason === 'busy') {
    return 'Stored usage data is temporarily busy. Try again.';
  }
  return 'Stored usage data could not be read safely.';
};

const usageStoreFailure = (error: unknown): ManualOperationResult<never> => {
  const reason = usageStoreReason(error);
  return {
    error: {
      message: usageStoreFailureMessage(reason),
      ...(reason === undefined ? {} : { reason }),
      tag: 'UsageStoreReadError',
    },
    ok: false,
  };
};

const manualMergeFilenameForMachine = (machine: UsageMachine, generatedAt: string): string => {
  const machineName = (machine.label || machine.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = generatedAt.replace(/[:.]/g, '-');
  return `ai-usage-${machineName || 'machine'}-${timestamp}.json`;
};

export const getSyncFleetForServer = async (
  readModel: Pick<UsageReadModel, 'readSyncFleet'>,
): Promise<ManualOperationResult<QueryUsageSyncFleetResult>> => {
  try {
    return { data: await readModel.readSyncFleet(), ok: true };
  } catch (error) {
    return usageStoreFailure(error);
  }
};

export const exportManualMergeBundleForServer = async (
  readModel: Pick<UsageReadModel, 'readLocalMergeBundle'>,
): Promise<ManualOperationResult<ManualMergeExportResult>> => {
  try {
    const bundle = await readModel.readLocalMergeBundle();
    const text = serializeUsageMergeBundle(bundle);
    return {
      data: {
        bytes: new TextEncoder().encode(text).byteLength,
        filename: manualMergeFilenameForMachine(bundle.machine, bundle.generatedAt),
        machine: bundle.machine,
        rows: bundle.rows.length,
        text,
      },
      ok: true,
    };
  } catch (error) {
    return usageStoreFailure(error);
  }
};
