import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import { normalizeCodexRateLimitStatus } from '@ai-usage/report-core/provider-status';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import type { ProviderQuotaBatch, ProviderQuotaCollectRequest } from './provider-quota';

const DEFAULT_MAXIMUM_FILES = 20;
const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024;
const DEFAULT_HISTORY_DAYS = 35;

const readMetadata = (storage: LocalHistoryStorageService, filePath: string) =>
  storage.readFileMetadata
    ? storage.readFileMetadata(filePath)
    : storage.readText(filePath).pipe(Effect.map((text) => ({ mtimeMs: 0, size: Buffer.byteLength(text) })));

const readRange = (storage: LocalHistoryStorageService, filePath: string, offset: number, maximumBytes: number) =>
  storage.readTextRange
    ? storage.readTextRange(filePath, offset, maximumBytes)
    : storage.readText(filePath).pipe(
        Effect.map((text) => {
          const buffer = Buffer.from(text).subarray(offset, offset + maximumBytes);
          return { bytesRead: buffer.byteLength, text: buffer.toString('utf8') };
        }),
      );

interface RolloutCursor {
  mtimeMs: number;
  offset: number;
  size: number;
}

export interface CodexRolloutQuotaOptions {
  maximumBytes?: number;
  maximumFiles?: number;
}

const parseCursor = (value: unknown): RolloutCursor | null => {
  if (!(typeof value === 'object' && value !== null)) {
    return null;
  }
  const cursor = value as Record<string, unknown>;
  return typeof cursor.mtimeMs === 'number' &&
    Number.isFinite(cursor.mtimeMs) &&
    Number.isSafeInteger(cursor.offset) &&
    Number(cursor.offset) >= 0 &&
    Number.isSafeInteger(cursor.size) &&
    Number(cursor.size) >= 0
    ? (cursor as unknown as RolloutCursor)
    : null;
};

const eventRateLimits = (value: unknown): { rateLimits: unknown; timestamp: string } | null => {
  if (!(typeof value === 'object' && value !== null)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) {
    return null;
  }
  if (!(typeof event.payload === 'object' && event.payload !== null)) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (payload.type !== 'token_count') {
    return null;
  }
  const info =
    typeof payload.info === 'object' && payload.info !== null ? (payload.info as Record<string, unknown>) : null;
  const rateLimits = payload.rate_limits ?? info?.rate_limits;
  return rateLimits == null ? null : { rateLimits, timestamp: new Date(event.timestamp).toISOString() };
};

const isExpiredReplay = (observation: ProviderQuotaObservation): boolean => {
  const resets = observation.windows
    .map((window) => window.resetsAt)
    .filter((reset): reset is string => reset !== null);
  return resets.length > 0 && resets.every((reset) => Date.parse(reset) <= Date.parse(observation.observedAt));
};

const normalizeRolloutObservation = (
  rateLimits: unknown,
  timestamp: string,
  request: ProviderQuotaCollectRequest,
): ProviderQuotaObservation | null => {
  const status = normalizeCodexRateLimitStatus({
    generatedAt: timestamp,
    machineId: request.machineId,
    ...(request.machineLabel ? { machineLabel: request.machineLabel } : {}),
    rateLimits,
    source: 'local-history',
  });
  if (!status) {
    return null;
  }
  const observation: ProviderQuotaObservation = {
    accountScope: request.accountScope ?? null,
    machineId: request.machineId,
    machineLabel: request.machineLabel ?? null,
    observedAt: timestamp,
    plan: status.plan ?? null,
    providerGeneratedAt: null,
    providerKey: 'codex',
    providerLabel: 'Codex',
    source: { confidence: 'historical', key: 'codex-rollout', mode: 'backfill' },
    state: status.state,
    windows: status.windows,
  };
  return isExpiredReplay(observation) ? null : observation;
};

const completeText = (text: string, reachedEnd: boolean): string => {
  if (reachedEnd && text.endsWith('\n')) {
    return text;
  }
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
};

export const collectCodexRolloutQuotaBatch = (
  request: ProviderQuotaCollectRequest,
  options: CodexRolloutQuotaOptions = {},
): Effect.Effect<ProviderQuotaBatch, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const from =
      request.from ?? new Date((request.observedAt ?? new Date()).getTime() - DEFAULT_HISTORY_DAYS * 86_400_000);
    const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    const maximumFiles = options.maximumFiles ?? DEFAULT_MAXIMUM_FILES;
    const files = (yield* walkFiles(storage, historyPath(storage, '.codex', 'sessions'), (name) =>
      name.endsWith('.jsonl'),
    )).sort();
    const observations: ProviderQuotaObservation[] = [];
    const checkpoints: ProviderQuotaBatch['checkpoints'] = [];
    const sourceEvents: ProviderQuotaBatch['sourceEvents'] = [];
    let bytesRemaining = maximumBytes;
    let processedFiles = 0;
    let hasMore = false;

    for (const filePath of files) {
      if (processedFiles >= maximumFiles || bytesRemaining <= 0) {
        hasMore = true;
        break;
      }
      const metadata = yield* readMetadata(storage, filePath);
      if (metadata.mtimeMs > 0 && metadata.mtimeMs < from.getTime()) {
        continue;
      }
      const cursor = parseCursor(request.cursors?.[filePath]);
      if (
        cursor &&
        cursor.size === metadata.size &&
        cursor.mtimeMs === metadata.mtimeMs &&
        cursor.offset >= metadata.size
      ) {
        continue;
      }
      const offset = cursor && metadata.size >= cursor.offset ? cursor.offset : 0;
      if (offset >= metadata.size) {
        checkpoints.push({ key: filePath, value: { ...metadata, offset } satisfies RolloutCursor });
        continue;
      }
      processedFiles++;
      const maximumRead = Math.min(bytesRemaining, metadata.size - offset);
      const range = yield* readRange(storage, filePath, offset, maximumRead);
      bytesRemaining -= range.bytesRead;
      const completed = completeText(range.text, offset + range.bytesRead >= metadata.size);
      let relativeOffset = 0;
      for (const line of completed.split('\n')) {
        if (!line) {
          relativeOffset += 1;
          continue;
        }
        const lineBytes = Buffer.byteLength(line) + 1;
        try {
          const event = eventRateLimits(JSON.parse(line) as unknown);
          if (event && Date.parse(event.timestamp) >= from.getTime()) {
            const observation = normalizeRolloutObservation(event.rateLimits, event.timestamp, request);
            if (observation) {
              const observationIndex = observations.length;
              observations.push(observation);
              sourceEvents.push({ key: `${filePath}:${offset + relativeOffset}`, observationIndex });
            }
          }
        } catch {
          // Malformed rollout lines are isolated from the rest of the bounded batch.
        }
        relativeOffset += lineBytes;
      }
      const committedBytes = Buffer.byteLength(completed);
      const nextOffset = offset + committedBytes;
      checkpoints.push({ key: filePath, value: { ...metadata, offset: nextOffset } satisfies RolloutCursor });
      if (nextOffset < metadata.size) {
        hasMore = true;
      }
    }

    return { checkpoints, hasMore, observations, sourceEvents };
  });
