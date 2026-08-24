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

export const publicationOutcomeLabel = (publication: SourcePublicationView): string => {
  if (publication.lastOutcome === 'success') {
    return 'Succeeded';
  }
  return publication.lastOutcome === 'failed' ? 'Failed' : 'Not published yet';
};

export const publicationStatus = (publication: SourcePublicationView): string => {
  if (publication.running) {
    return 'Publishing stored data now.';
  }
  if (publication.queued) {
    return 'Publishing is queued.';
  }
  if (!publication.pendingDemand) {
    return 'The report is up to date with everything collected.';
  }
  return rtkDependencyStatus(publication).behind
    ? 'New data is waiting to be published once RTK savings enrichment catches up.'
    : 'New data is waiting to be published.';
};
