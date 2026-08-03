import {
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
} from '@ai-usage/report-core/provider-quota';
import { queryProviderQuotaHistory } from '@ai-usage/report-data/provider-quota-history';
import { Effect } from 'effect';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

export const getProviderQuotaHistoryForServer = async (
  request: ProviderQuotaHistoryRequest,
  options: { readonly dbPath?: string; readonly now?: () => Date; readonly signal?: AbortSignal } = {},
): Promise<ProviderQuotaHistoryResult> => {
  const parsed = parseProviderQuotaHistoryRequest(request);
  options.signal?.throwIfAborted();
  const read = () =>
    Effect.runPromise(
      Effect.either(
        queryProviderQuotaHistory({
          dbPath: options.dbPath ?? resolveUsageWebRuntimePaths().databasePath,
          from: parsed.from,
          ...(parsed.machineId === undefined ? {} : { machineId: parsed.machineId }),
          ...(parsed.maximumPoints === undefined ? {} : { maximumPoints: parsed.maximumPoints }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(parsed.providerKey === undefined ? {} : { providerKey: parsed.providerKey }),
          to: parsed.to,
        }),
      ),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read();
  } catch (error) {
    options.signal?.throwIfAborted();
    throw error;
  }
  options.signal?.throwIfAborted();
  if (result._tag === 'Left') {
    throw new Error('Provider quota history is unavailable.');
  }
  return result.right;
};
