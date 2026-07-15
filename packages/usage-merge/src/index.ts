import { createHash } from 'node:crypto';
import { parseUsageMergeBundle, serializeUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  confirmPeerMergeBundle,
  exportLocalMergeBundle,
  type ImportResult,
  importPeerMergeBundle,
  previewPeerMergeBundle,
} from '@ai-usage/usage-store';
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

export interface ManualMergeDocumentInput {
  bytes: Uint8Array;
  text: string;
}

export interface ManualMergePreviewResult extends ImportResult {
  bytes: number;
  digest: string;
  generatedAt: string;
  machine: UsageMachine;
  rows: number;
  storeGeneration: number;
  storeStateToken: string;
  warningCount: number;
  warningItems: string[];
}

export interface ManualMergeConfirmInput extends ManualMergeDocumentInput {
  expectedDigest: string;
  expectedStoreGeneration: number;
  expectedStoreStateToken: string;
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

export type UsageMergeErrorReason = 'invalid-input' | 'self-merge' | 'store-failed' | 'preview-stale';

export class UsageMergeError extends Data.TaggedError('UsageMergeError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly operation: string;
  readonly reason: UsageMergeErrorReason;
}> {}

export interface UsageFileMergeService {
  confirmManualMergeBundle(input: ManualMergeConfirmInput): Effect.Effect<ManualMergeImportResult, UsageMergeError>;
  exportManualMergeBundle(): Effect.Effect<ManualMergeExportResult, UsageMergeError>;
  importManualMergeBundle(input: ManualMergeImportInput): Effect.Effect<ManualMergeImportResult, UsageMergeError>;
  previewManualMergeBundle(input: ManualMergeDocumentInput): Effect.Effect<ManualMergePreviewResult, UsageMergeError>;
}

export const MAX_MANUAL_MERGE_PREVIEW_WARNINGS = 20;
const MAX_PREVIEW_WARNING_CHARACTERS = 512;
const WHITESPACE_PATTERN = /\s+/g;

const documentDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const mergeReasonFromStore = (reason: string | undefined): UsageMergeErrorReason => {
  if (reason === 'preview-stale') {
    return 'preview-stale';
  }
  if (reason === 'self-import') {
    return 'self-merge';
  }
  return 'store-failed';
};

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
    previewManualMergeBundle: (input) =>
      Effect.gen(function* () {
        const bundle = yield* Effect.try({
          try: () => parseUsageMergeBundle(input.text),
          catch: (cause) =>
            usageMergeError('previewManualMergeBundle', 'Could not parse usage merge preview.', 'invalid-input', cause),
        });
        const preview = yield* previewPeerMergeBundle({
          dbPath: options.dbPath,
          localMachineId: options.localMachine.id,
          bundle,
        }).pipe(
          Effect.mapError((cause) =>
            usageMergeError(
              'previewManualMergeBundle',
              `Could not preview usage merge file from ${bundle.machine.label}.`,
              cause.reason === 'self-import' ? 'self-merge' : 'store-failed',
              cause,
            ),
          ),
        );
        const { generation, storeStateToken, ...result } = preview;
        return {
          ...result,
          bytes: input.bytes.byteLength,
          digest: documentDigest(input.bytes),
          generatedAt: bundle.generatedAt,
          machine: bundle.machine,
          rows: bundle.rows.length,
          storeGeneration: generation,
          storeStateToken,
          warningCount: bundle.warnings.length,
          warningItems: bundle.warnings
            .slice(0, MAX_MANUAL_MERGE_PREVIEW_WARNINGS)
            .map((warning) =>
              warning.message.replace(WHITESPACE_PATTERN, ' ').slice(0, MAX_PREVIEW_WARNING_CHARACTERS),
            ),
        };
      }),
    confirmManualMergeBundle: (input) =>
      Effect.gen(function* () {
        const digest = documentDigest(input.bytes);
        if (digest !== input.expectedDigest) {
          return yield* Effect.fail(
            usageMergeError('confirmManualMergeBundle', 'The selected file changed after preview.', 'preview-stale'),
          );
        }
        const bundle = yield* Effect.try({
          try: () => parseUsageMergeBundle(input.text),
          catch: (cause) =>
            usageMergeError(
              'confirmManualMergeBundle',
              'Could not parse usage merge confirmation.',
              'invalid-input',
              cause,
            ),
        });
        const result = yield* confirmPeerMergeBundle({
          dbPath: options.dbPath,
          localMachineId: options.localMachine.id,
          bundle,
          importedAt: now(),
          expectedGeneration: input.expectedStoreGeneration,
          expectedStoreStateToken: input.expectedStoreStateToken,
        }).pipe(
          Effect.mapError((cause) =>
            usageMergeError(
              'confirmManualMergeBundle',
              `Could not confirm usage merge file from ${bundle.machine.label}.`,
              mergeReasonFromStore(cause.reason),
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
