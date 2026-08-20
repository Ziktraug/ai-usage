import { createHash } from 'node:crypto';
import { parseUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import {
  type MergeDocumentDigest,
  type MergePreviewProof,
  parseMergeDocumentDigest,
} from '@ai-usage/report-core/merge-proof';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { confirmPeerMergeBundle, type ImportResult, previewPeerMergeBundle } from '@ai-usage/usage-store/writer';
import { Data, Effect } from 'effect';

export interface ManualMergeDocumentInput {
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface ManualMergePreviewResult extends ImportResult, MergePreviewProof {
  readonly bytes: number;
  readonly generatedAt: string;
  readonly machine: UsageMachine;
  readonly rows: number;
  readonly warningCount: number;
  readonly warningItems: string[];
}

export interface ManualMergeConfirmInput extends ManualMergeDocumentInput, MergePreviewProof {}

export interface ManualMergeConfirmResult {
  readonly generatedAt: string;
  readonly machine: UsageMachine;
  readonly result: ImportResult;
  readonly rows: number;
  readonly warnings: number;
}

export type UsageMergeErrorReason = 'invalid-input' | 'invalid-json' | 'preview-stale' | 'self-merge' | 'store-failed';

export class UsageMergeError extends Data.TaggedError('UsageMergeError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly operation: string;
  readonly reason: UsageMergeErrorReason;
}> {}

export interface UsageFileMergeService {
  readonly confirmManualMergeBundle: (
    input: ManualMergeConfirmInput,
  ) => Effect.Effect<ManualMergeConfirmResult, UsageMergeError>;
  readonly previewManualMergeBundle: (
    input: ManualMergeDocumentInput,
  ) => Effect.Effect<ManualMergePreviewResult, UsageMergeError>;
}

export interface UsageFileMergeServiceOptions {
  readonly dbPath: string;
  readonly localMachine: UsageMachine;
  readonly now?: () => Date;
}

export const MAX_MANUAL_MERGE_PREVIEW_WARNINGS = 20;
const MAX_PREVIEW_WARNING_CHARACTERS = 512;
const WHITESPACE_PATTERN = /\s+/g;

const documentDigest = (bytes: Uint8Array): MergeDocumentDigest =>
  parseMergeDocumentDigest(createHash('sha256').update(bytes).digest('hex'));

const mergeReasonFromStore = (reason: string | undefined): UsageMergeErrorReason => {
  if (reason === 'invalid-input') {
    return 'invalid-input';
  }
  if (reason === 'preview-stale') {
    return 'preview-stale';
  }
  if (reason === 'self-import') {
    return 'self-merge';
  }
  return 'store-failed';
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

const parseMergeDocument = (text: string, operation: string) => {
  try {
    return parseUsageMergeBundle(text);
  } catch (cause) {
    throw usageMergeError(
      operation,
      'Could not parse usage merge document.',
      cause instanceof SyntaxError ? 'invalid-json' : 'invalid-input',
      cause,
    );
  }
};

export const createUsageFileMergeService = (options: UsageFileMergeServiceOptions): UsageFileMergeService => ({
  confirmManualMergeBundle: (input) =>
    Effect.gen(function* () {
      if (documentDigest(input.bytes) !== input.documentDigest) {
        return yield* Effect.fail(
          usageMergeError('confirmManualMergeBundle', 'The selected file changed after preview.', 'preview-stale'),
        );
      }
      const bundle = yield* Effect.try({
        try: () => parseMergeDocument(input.text, 'confirmManualMergeBundle'),
        catch: (cause) =>
          cause instanceof UsageMergeError
            ? cause
            : usageMergeError(
                'confirmManualMergeBundle',
                'Could not parse usage merge confirmation.',
                'invalid-input',
                cause,
              ),
      });
      const result = yield* confirmPeerMergeBundle({
        bundle,
        confirmationToken: input.confirmationToken,
        dbPath: options.dbPath,
        importedAt: options.now?.() ?? new Date(),
        localMachineId: options.localMachine.id,
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
        generatedAt: bundle.generatedAt,
        machine: bundle.machine,
        result,
        rows: bundle.rows.length,
        warnings: bundle.warnings.length,
      };
    }),
  previewManualMergeBundle: (input) =>
    Effect.gen(function* () {
      const bundle = yield* Effect.try({
        try: () => parseMergeDocument(input.text, 'previewManualMergeBundle'),
        catch: (cause) =>
          cause instanceof UsageMergeError
            ? cause
            : usageMergeError(
                'previewManualMergeBundle',
                'Could not parse usage merge preview.',
                'invalid-input',
                cause,
              ),
      });
      const preview = yield* previewPeerMergeBundle({
        bundle,
        dbPath: options.dbPath,
        localMachineId: options.localMachine.id,
      }).pipe(
        Effect.mapError((cause) =>
          usageMergeError(
            'previewManualMergeBundle',
            `Could not preview usage merge file from ${bundle.machine.label}.`,
            mergeReasonFromStore(cause.reason),
            cause,
          ),
        ),
      );
      const { confirmationToken, ...result } = preview;
      return {
        ...result,
        bytes: input.bytes.byteLength,
        confirmationToken,
        documentDigest: documentDigest(input.bytes),
        generatedAt: bundle.generatedAt,
        machine: bundle.machine,
        rows: bundle.rows.length,
        warningCount: bundle.warnings.length,
        warningItems: bundle.warnings
          .slice(0, MAX_MANUAL_MERGE_PREVIEW_WARNINGS)
          .map((warning) => warning.message.replace(WHITESPACE_PATTERN, ' ').slice(0, MAX_PREVIEW_WARNING_CHARACTERS)),
      };
    }),
});
