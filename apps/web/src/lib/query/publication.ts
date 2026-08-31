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
 * Everything a completed publication cycle makes stale.
 *
 * The trigger is the *cycle*, not a new revision — see `publicationIdentity` in the source-control
 * service. A cycle that leaves the report rows identical renews the current revision rather than
 * assembling a new one, and an observation-only sweep is exactly that shape.
 *
 * Both families here are dependents of the cycle rather than of the revision. Skill observations
 * are written by it, so this is their immediate producer-driven freshness path; their named policy
 * also revalidates the time-bounded completeness proof on an interval and on focus. The report
 * aliases move too: a renewal rewrites the served revision's `publishedAt` and `expiresAt`, which
 * the manifest carries.
 */
export const publicationInvalidatedKeys = (): readonly PublicationInvalidatedQueryKey[] => [
  ...currentReportAliasKeys(),
  skillObservationsKey(),
];
