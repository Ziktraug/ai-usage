import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { Effect } from 'effect';

export interface ProviderQuotaCollectRequest<CursorError = unknown> {
  accountScope?: string | null;
  cursors?: Record<string, unknown>;
  from?: Date;
  /** Read only the checkpoints for the current bounded group of history files. */
  loadCursors?: (keys: readonly string[]) => Effect.Effect<Record<string, unknown>, CursorError>;
  machineId: string;
  machineLabel?: string | null;
  observedAt?: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaBatchCheckpoint {
  key: string;
  value: unknown;
}

export interface ProviderQuotaSourceEvent {
  key: string;
  observationIndex: number;
}

export interface ProviderQuotaBatch {
  checkpoints: ProviderQuotaBatchCheckpoint[];
  hasMore: boolean;
  observations: ProviderQuotaObservation[];
  sourceEvents: ProviderQuotaSourceEvent[];
}

export interface ProviderQuotaBatchSource<Error = unknown> {
  collect<CursorError = never>(
    request: ProviderQuotaCollectRequest<CursorError>,
  ): Effect.Effect<ProviderQuotaBatch, Error | CursorError>;
}
