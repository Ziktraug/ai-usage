import { skillObservationsKey } from './identities/skills';
import { type CollectionSwrQueryKey, type CurrentAliasQueryKey, currentAliasKey } from './keys';

const reportManifestFamily = 'report-manifest';
const reportBootstrapFamily = 'report-bootstrap';

export const currentReportAliasKeys = (): readonly [CurrentAliasQueryKey, CurrentAliasQueryKey] => [
  currentAliasKey(reportManifestFamily),
  currentAliasKey(reportBootstrapFamily),
];

export type PublicationInvalidatedQueryKey = CollectionSwrQueryKey | CurrentAliasQueryKey;

/**
 * Everything a completed source publication makes stale.
 *
 * A publication is the engine announcing that a collection cycle finished and durable data moved.
 * The report aliases are the obvious dependents; skill observations are the other, because they are
 * written by that same cycle and their query policy revalidates on nothing — not mount, not focus,
 * not reconnect. Without this an open `/skills` tab would show the observations it loaded on first
 * paint for as long as it stayed open, which is precisely the staleness that policy trades away
 * pointless refetching for. This is the trade's other half.
 */
export const publicationInvalidatedKeys = (): readonly PublicationInvalidatedQueryKey[] => [
  ...currentReportAliasKeys(),
  skillObservationsKey(),
];
