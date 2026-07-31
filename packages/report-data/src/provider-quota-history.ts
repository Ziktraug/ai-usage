import {
  downsampleProviderQuotaHistoryPoints,
  type ProviderQuotaCoverage,
  type ProviderQuotaHistoryPoint,
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
  projectProviderQuotaObservation,
} from '@ai-usage/report-core/provider-quota';
import {
  queryLatestProviderQuotaObservations,
  queryProviderQuotaObservations,
  type UsageStoreError,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

export interface QueryProviderQuotaHistoryInput extends ProviderQuotaHistoryRequest {
  readonly dbPath: string;
  readonly now?: () => Date;
}

const coverageForPoints = (points: ProviderQuotaHistoryPoint[]): ProviderQuotaCoverage[] => {
  const groups = new Map<string, ProviderQuotaHistoryPoint[]>();
  for (const point of points) {
    const key = `${point.providerKey}|${point.machineId}|${point.accountScope ?? ''}|${point.source.key}|${point.windowId}`;
    const rows = groups.get(key) ?? [];
    rows.push(point);
    groups.set(key, rows);
  }
  return [...groups.values()].map((rows) => {
    rows.sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
    const first = rows[0];
    const last = rows.at(-1);
    if (!(first && last)) {
      throw new Error('Provider quota coverage group is empty.');
    }
    let largestGapMs = 0;
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous && current) {
        largestGapMs = Math.max(
          largestGapMs,
          Date.parse(current.firstObservedAt) - Date.parse(previous.lastObservedAt),
        );
      }
    }
    return {
      accountScope: first.accountScope,
      firstObservedAt: first.firstObservedAt,
      lastObservedAt: last.lastObservedAt,
      largestGapMs,
      machineId: first.machineId,
      pointCount: rows.length,
      providerKey: first.providerKey,
      sourceConfidence: first.source.confidence,
      sourceKey: first.source.key,
      windowId: first.windowId,
    };
  });
};

export const queryProviderQuotaHistory = (
  input: QueryProviderQuotaHistoryInput,
): Effect.Effect<ProviderQuotaHistoryResult, UsageStoreError> =>
  Effect.gen(function* () {
    const request = parseProviderQuotaHistoryRequest({
      from: input.from,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.maximumPoints === undefined ? {} : { maximumPoints: input.maximumPoints }),
      ...(input.providerKey === undefined ? {} : { providerKey: input.providerKey }),
      to: input.to,
    });
    const stored = yield* queryProviderQuotaObservations({
      dbPath: input.dbPath,
      from: request.from,
      ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
      maximumObservations: (request.maximumPoints ?? 1000) * 4,
      ...(request.providerKey === undefined ? {} : { providerKey: request.providerKey }),
      to: request.to,
    });
    const points: ProviderQuotaHistoryPoint[] = stored.observations.flatMap(
      ({ firstObservedAt, lastObservedAt, observation }) =>
        observation.windows.map((window) => ({
          accountScope: observation.accountScope,
          blocked: window.blocked,
          firstObservedAt,
          group: window.group,
          lastObservedAt,
          limitSeconds: window.limitSeconds,
          machineId: observation.machineId,
          machineLabel: observation.machineLabel,
          providerKey: observation.providerKey,
          providerLabel: observation.providerLabel,
          resetAt: window.resetsAt,
          source: observation.source,
          usedPercent: window.usedPercent,
          windowId: window.id,
          windowLabel: window.label,
        })),
    );
    const reduced = downsampleProviderQuotaHistoryPoints(points, request.maximumPoints ?? 1000);
    const latest = yield* queryLatestProviderQuotaObservations({
      dbPath: input.dbPath,
      ...(request.machineId === undefined ? {} : { machineId: request.machineId }),
      ...(request.providerKey === undefined ? {} : { providerKey: request.providerKey }),
    });
    return {
      coverage: coverageForPoints(points),
      generatedAt: (input.now?.() ?? new Date()).toISOString(),
      latest: latest.observations.map(({ observation }) => projectProviderQuotaObservation(observation)),
      points: reduced.points,
      skipped: stored.skipped + latest.skipped,
      truncated: stored.truncated || reduced.truncated,
    };
  });
