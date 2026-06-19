import type { UsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { CollectedUsageRow, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Data, Effect } from 'effect';

export type StoredUsageRowStatus = 'active' | 'superseded' | 'deleted';

export interface ImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
  superseded: number;
  deleted: number;
  warnings: number;
}

export interface ImportLocalRowsInput {
  machine: UsageMachine;
  rows: UsageRowWithOptionalSource[];
  importedAt?: Date;
}

export interface ExportLocalMergeBundleInput {
  machine: UsageMachine;
  generatedAt?: Date;
}

export interface ImportPeerMergeBundleInput {
  localMachineId: string;
  bundle: UsageMergeBundle;
  importedAt?: Date;
}

export interface QueryReportRowsInput {
  originMachineIds?: string[];
  statuses?: StoredUsageRowStatus[];
}

export interface QueryRowsResult {
  rows: CollectedUsageRow[];
}

export type UsageStoreErrorReason = 'invalid-input' | 'self-import' | 'storage-failure' | 'migration-failure';

export class UsageStoreError extends Data.TaggedError('UsageStoreError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: UsageStoreErrorReason;
  readonly cause?: unknown;
}> {}

export interface UsageStore {
  importLocalRows(input: ImportLocalRowsInput): Effect.Effect<ImportResult, UsageStoreError>;
  exportLocalMergeBundle(input: ExportLocalMergeBundleInput): Effect.Effect<UsageMergeBundle, UsageStoreError>;
  importPeerMergeBundle(input: ImportPeerMergeBundleInput): Effect.Effect<ImportResult, UsageStoreError>;
  queryReportRows(input?: QueryReportRowsInput): Effect.Effect<QueryRowsResult, UsageStoreError>;
}
