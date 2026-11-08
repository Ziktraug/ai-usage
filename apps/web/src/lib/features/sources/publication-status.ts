import type { SourcePublicationView } from '@ai-usage/report-core/source-control';

export interface RtkDependencyStatus {
  readonly behind: boolean;
  readonly label: string;
  readonly title: string;
}

export const rtkDependencyStatus = (publication: SourcePublicationView): RtkDependencyStatus => {
  const behind = publication.rtkCompletedGeneration < publication.rtkRequiredGeneration;
  return {
    behind,
    label: behind ? 'Behind — publishing waits for it' : 'Up to date',
    title: `RTK savings generation ${publication.rtkCompletedGeneration} of ${publication.rtkRequiredGeneration} required`,
  };
};

export const pendingPublishRequests = (publication: SourcePublicationView): number =>
  Math.max(0, publication.requestedGeneration - publication.acknowledgedRequestGeneration);

export const publicationHealthy = (publication: SourcePublicationView): boolean =>
  (publication.lastOutcome === 'success' ||
    (publication.lastOutcome === 'not-run' && publication.revision !== undefined)) &&
  !publication.running &&
  !publication.queued &&
  !publication.pendingDemand &&
  !publication.dirty &&
  pendingPublishRequests(publication) === 0 &&
  !rtkDependencyStatus(publication).behind;

export const publicationOutcomeLabel = (publication: SourcePublicationView): string => {
  if (publication.lastOutcome === 'success') {
    return 'Succeeded';
  }
  if (publication.lastOutcome === 'not-run' && publication.revision !== undefined) {
    return 'Published';
  }
  return publication.lastOutcome === 'failed' ? 'Failed' : 'Not published yet';
};

export const publicationStatus = (publication: SourcePublicationView): string => {
  if (publication.lastOutcome === 'failed') {
    if (publication.running) {
      return 'The last publish failed; retrying now.';
    }
    if (publication.queued) {
      return 'The last publish failed; a retry is queued.';
    }
    return 'The last publish failed. Run all enabled to retry publishing the collected data.';
  }
  if (publication.running) {
    return 'Publishing stored data now.';
  }
  if (publication.queued) {
    return 'Publishing is queued.';
  }
  if (publication.lastOutcome === 'not-run' && publication.revision === undefined) {
    return 'The report has not been published yet. Run all enabled to collect and publish local history.';
  }
  if (rtkDependencyStatus(publication).behind) {
    return 'New data is waiting to be published once RTK savings enrichment catches up.';
  }
  if (publication.dirty || publication.pendingDemand || pendingPublishRequests(publication) > 0) {
    return 'New data is waiting to be published.';
  }
  return 'The report is up to date with everything collected.';
};
