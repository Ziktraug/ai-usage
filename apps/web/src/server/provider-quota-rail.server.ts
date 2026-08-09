import { buildProviderQuotaRail, type ProviderQuotaRailEntry } from '../lib/features/shell/provider-quota-rail';
import type { UsageReadModel, UsageReadModelCallOptions } from './usage-read-model.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';

/**
 * The rail rides in the layout, so it renders on every route including the ones that have nothing to
 * do with the report. A read failure therefore degrades to "nothing measured" rather than propagating
 * — a missing quota database must not take out `/skills` or `/sync`.
 */
export const getProviderQuotaRailForServer = async (
  readModel?: Pick<UsageReadModel, 'readLatestProviderQuota'>,
  resolveReadModel: () => Promise<Pick<UsageReadModel, 'readLatestProviderQuota'>> = resolveUsageReadModelForServer,
  options: UsageReadModelCallOptions = {},
  now: Date = new Date(),
): Promise<ProviderQuotaRailEntry[]> => {
  try {
    options.signal?.throwIfAborted();
    const activeReadModel = readModel ?? (await resolveReadModel());
    const dataset = await activeReadModel.readLatestProviderQuota(options);
    options.signal?.throwIfAborted();
    return buildProviderQuotaRail(dataset, now);
  } catch (cause) {
    // A cancelled request still has to cancel; only genuine read failures degrade.
    options.signal?.throwIfAborted();
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw cause;
    }
    return buildProviderQuotaRail(null, now);
  }
};
