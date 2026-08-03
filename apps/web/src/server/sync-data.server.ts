import { parseUsageMergeBundle, serializeUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  type QueryUsageSyncFleetResult,
  type UsageStoreErrorReason,
  usageStoreErrorReasonFrom,
} from '@ai-usage/usage-store/reader';
import type { ManualOperationResult } from '../manual-transfer-contract';
import type { UsageReadModel, UsageReadModelCallOptions } from './usage-read-model.server';

export interface ManualMergeExportResult {
  readonly bytes: number;
  readonly filename: string;
  readonly machine: UsageMachine;
  readonly rows: number;
  readonly text: string;
}

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
  const reason = usageStoreErrorReasonFrom(error);
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
  options: UsageReadModelCallOptions = {},
): Promise<ManualOperationResult<QueryUsageSyncFleetResult>> => {
  try {
    const data = await readModel.readSyncFleet(options);
    options.signal?.throwIfAborted();
    return { data, ok: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    return usageStoreFailure(error);
  }
};

export const exportManualMergeBundleForServer = async (
  readModel: Pick<UsageReadModel, 'readLocalMergeBundle'>,
  options: UsageReadModelCallOptions = {},
): Promise<ManualOperationResult<ManualMergeExportResult>> => {
  try {
    const bundle = await readModel.readLocalMergeBundle(options);
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    return usageStoreFailure(error);
  }
};

export const canonicalizeManualMergeExportForServer = (candidate: {
  readonly text: string;
}): {
  readonly bytes: number;
  readonly filename: string;
  readonly rows: number;
  readonly text: string;
} => {
  const bundle = parseUsageMergeBundle(candidate.text);
  const text = serializeUsageMergeBundle(bundle);
  return {
    bytes: new TextEncoder().encode(text).byteLength,
    filename: manualMergeFilenameForMachine(bundle.machine, bundle.generatedAt),
    rows: bundle.rows.length,
    text,
  };
};
