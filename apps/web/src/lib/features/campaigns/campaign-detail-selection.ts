import {
  type SessionLookupResult,
  type SessionPresentationRow,
  sessionCampaignIdentityForRow,
  sessionLookupFingerprint,
} from '@ai-usage/report-core/session-query';
import { sessionAnalysisTargetForSession } from '../../../session-analysis-target';
import type { SessionSelectionInput } from '../sessions/detail/types';

export type CampaignDetailSelection =
  | { readonly kind: 'closed' | 'loading' | 'missing' }
  | { readonly kind: 'open'; readonly selection: SessionSelectionInput };

/** Resolve one URL identity without changing the campaign's paging or scroll intent. */
export const resolveCampaignDetailSelection = (input: {
  readonly campaignKey: string;
  readonly knownRevision: string | undefined;
  readonly knownRows: readonly SessionPresentationRow[];
  readonly lookup: Pick<SessionLookupResult, 'requestFingerprint' | 'revision' | 'row'> | undefined;
  readonly revision: string | undefined;
  readonly rowId: string;
}): CampaignDetailSelection => {
  if (!input.rowId) {
    return { kind: 'closed' };
  }
  if (!(input.revision && input.campaignKey)) {
    return { kind: 'loading' };
  }
  const known =
    input.knownRevision === input.revision ? input.knownRows.find((row) => row.rowId === input.rowId) : undefined;
  const lookup =
    input.lookup?.revision === input.revision &&
    input.lookup.requestFingerprint === sessionLookupFingerprint({ revision: input.revision, rowId: input.rowId })
      ? input.lookup
      : undefined;
  const row = known ?? lookup?.row;
  if (row === null) {
    return { kind: 'missing' };
  }
  // An observer may retain the same row at an older revision. A response for a
  // superseded URL or revision cannot become the newly requested selection.
  if (!row || row.rowId !== input.rowId) {
    return { kind: 'loading' };
  }
  if (sessionCampaignIdentityForRow(row).campaignKey !== input.campaignKey) {
    return { kind: 'missing' };
  }
  return {
    kind: 'open',
    selection: { revision: input.revision, row, target: sessionAnalysisTargetForSession(row) },
  };
};
