import { parseUsageMergeBundle, serializeUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { exportLocalMergeBundle, type ImportResult, importPeerMergeBundle } from '@ai-usage/usage-store';
import { Data, Effect } from 'effect';

export interface ManualMergeExportResult {
  bytes: number;
  filename: string;
  machine: UsageMachine;
  rows: number;
  text: string;
}

export interface ManualMergeImportInput {
  text: string;
}

export interface ManualMergeImportResult {
  generatedAt: string;
  machine: UsageMachine;
  result: ImportResult;
  rows: number;
  warnings: number;
}

export interface UsageFileMergeServiceOptions {
  dbPath: string;
  localMachine: UsageMachine;
  now?: () => Date;
}

export type UsageMergeErrorReason = 'invalid-input' | 'self-merge' | 'store-failed';

export class UsageMergeError extends Data.TaggedError('UsageMergeError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly operation: string;
  readonly reason: UsageMergeErrorReason;
}> {}

export interface UsageFileMergeService {
  exportManualMergeBundle(): Effect.Effect<ManualMergeExportResult, UsageMergeError>;
  importManualMergeBundle(input: ManualMergeImportInput): Effect.Effect<ManualMergeImportResult, UsageMergeError>;
}

const manualMergeFilenameForMachine = (machine: UsageMachine, generatedAt: Date) => {
  const machineName = (machine.label || machine.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return `ai-usage-${machineName || 'machine'}-${timestamp}.json`;
};

const usageMergeError = (
  operation: string,
  message: string,
  reason: UsageMergeErrorReason,
  cause?: unknown,
): UsageMergeError =>
  new UsageMergeError({
    operation,
    message,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

export const createUsageFileMergeService = (options: UsageFileMergeServiceOptions): UsageFileMergeService => {
  const now = () => options.now?.() ?? new Date();

  return {
    exportManualMergeBundle: () => {
      const generatedAt = now();
      return exportLocalMergeBundle({
        dbPath: options.dbPath,
        machine: options.localMachine,
        generatedAt,
      }).pipe(
        Effect.map((bundle) => {
          const text = serializeUsageMergeBundle(bundle);
          return {
            bytes: new TextEncoder().encode(text).byteLength,
            filename: manualMergeFilenameForMachine(options.localMachine, generatedAt),
            machine: bundle.machine,
            rows: bundle.rows.length,
            text,
          };
        }),
        Effect.mapError((cause) =>
          usageMergeError('exportManualMergeBundle', 'Could not export local usage merge file.', 'store-failed', cause),
        ),
      );
    },
    importManualMergeBundle: (input) =>
      Effect.gen(function* () {
        const bundle = yield* Effect.try({
          try: () => parseUsageMergeBundle(input.text),
          catch: (cause) =>
            usageMergeError(
              'importManualMergeBundle',
              `Could not parse usage merge file: ${cause instanceof Error ? cause.message : String(cause)}`,
              'invalid-input',
              cause,
            ),
        });
        const result = yield* importPeerMergeBundle({
          dbPath: options.dbPath,
          localMachineId: options.localMachine.id,
          bundle,
          importedAt: now(),
        }).pipe(
          Effect.mapError((cause) =>
            usageMergeError(
              'importManualMergeBundle',
              `Could not import usage merge file from ${bundle.machine.label}.`,
              cause.reason === 'self-import' ? 'self-merge' : 'store-failed',
              cause,
            ),
          ),
        );
        return {
          machine: bundle.machine,
          generatedAt: bundle.generatedAt,
          rows: bundle.rows.length,
          warnings: bundle.warnings.length,
          result,
        };
      }),
  };
};
