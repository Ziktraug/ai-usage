import { createHash } from 'node:crypto';
import { parseUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { confirmPeerMergeBundle, type ImportResult, previewPeerMergeBundle } from '@ai-usage/usage-store/writer';
import { Data, Effect } from 'effect';

export interface EngineMergeDocumentInput {
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface EngineMergePreviewResult extends ImportResult {
  readonly bytes: number;
  readonly confirmationToken: string;
  readonly digest: string;
  readonly generatedAt: string;
  readonly machine: UsageMachine;
  readonly rows: number;
  readonly warningCount: number;
  readonly warningItems: string[];
}

export interface EngineMergeConfirmInput extends EngineMergeDocumentInput {
  readonly confirmationToken: string;
  readonly expectedDigest: string;
}

export interface EngineMergeConfirmResult {
  readonly generatedAt: string;
  readonly machine: UsageMachine;
  readonly result: ImportResult;
  readonly rows: number;
  readonly warnings: number;
}

export type EngineMergeErrorReason = 'invalid-input' | 'invalid-json' | 'preview-stale' | 'self-merge' | 'store-failed';

export class EngineMergeError extends Data.TaggedError('EngineMergeError')<{
  readonly cause?: unknown;
  readonly message: string;
  readonly operation: string;
  readonly reason: EngineMergeErrorReason;
}> {}

export interface EngineUsageMergeService {
  readonly confirm: (input: EngineMergeConfirmInput) => Effect.Effect<EngineMergeConfirmResult, EngineMergeError>;
  readonly preview: (input: EngineMergeDocumentInput) => Effect.Effect<EngineMergePreviewResult, EngineMergeError>;
}

interface EngineUsageMergeServiceOptions {
  readonly dbPath: string;
  readonly localMachine: UsageMachine;
  readonly now?: () => Date;
}

const MAX_PREVIEW_WARNINGS = 20;
const MAX_PREVIEW_WARNING_CHARACTERS = 512;
const WHITESPACE_PATTERN = /\s+/g;

const documentDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const mergeReasonFromStore = (reason: string | undefined): EngineMergeErrorReason => {
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

const engineMergeError = (
  operation: string,
  message: string,
  reason: EngineMergeErrorReason,
  cause?: unknown,
): EngineMergeError =>
  new EngineMergeError({
    operation,
    message,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const parseMergeDocument = (text: string, operation: string) => {
  try {
    return parseUsageMergeBundle(text);
  } catch (cause) {
    throw engineMergeError(
      operation,
      'Could not parse usage merge document.',
      cause instanceof SyntaxError ? 'invalid-json' : 'invalid-input',
      cause,
    );
  }
};

export const createEngineUsageMergeService = (options: EngineUsageMergeServiceOptions): EngineUsageMergeService => ({
  confirm: (input) =>
    Effect.gen(function* () {
      const digest = documentDigest(input.bytes);
      if (digest !== input.expectedDigest) {
        return yield* Effect.fail(
          engineMergeError('confirmMerge', 'The selected file changed after preview.', 'preview-stale'),
        );
      }
      const bundle = yield* Effect.try({
        try: () => parseMergeDocument(input.text, 'confirmMerge'),
        catch: (cause) =>
          cause instanceof EngineMergeError
            ? cause
            : engineMergeError('confirmMerge', 'Could not parse usage merge confirmation.', 'invalid-input', cause),
      });
      const result = yield* confirmPeerMergeBundle({
        bundle,
        confirmationToken: input.confirmationToken,
        dbPath: options.dbPath,
        importedAt: options.now?.() ?? new Date(),
        localMachineId: options.localMachine.id,
      }).pipe(
        Effect.mapError((cause) =>
          engineMergeError(
            'confirmMerge',
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
  preview: (input) =>
    Effect.gen(function* () {
      const bundle = yield* Effect.try({
        try: () => parseMergeDocument(input.text, 'previewMerge'),
        catch: (cause) =>
          cause instanceof EngineMergeError
            ? cause
            : engineMergeError('previewMerge', 'Could not parse usage merge preview.', 'invalid-input', cause),
      });
      const preview = yield* previewPeerMergeBundle({
        bundle,
        dbPath: options.dbPath,
        localMachineId: options.localMachine.id,
      }).pipe(
        Effect.mapError((cause) =>
          engineMergeError(
            'previewMerge',
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
        digest: documentDigest(input.bytes),
        generatedAt: bundle.generatedAt,
        machine: bundle.machine,
        rows: bundle.rows.length,
        warningCount: bundle.warnings.length,
        warningItems: bundle.warnings
          .slice(0, MAX_PREVIEW_WARNINGS)
          .map((warning) => warning.message.replace(WHITESPACE_PATTERN, ' ').slice(0, MAX_PREVIEW_WARNING_CHARACTERS)),
      };
    }),
});
