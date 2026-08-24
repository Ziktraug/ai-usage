import { describe, expect, test } from 'bun:test';
import type { SourcePublicationView } from '@ai-usage/report-core/source-control';
import {
  pendingPublishRequests,
  publicationOutcomeLabel,
  publicationStatus,
  rtkDependencyStatus,
} from './publication-status';

const PUBLICATION_JARGON_PATTERN = /demand|acknowledg|dependency|Caught up/i;

const publication = (overrides: Partial<SourcePublicationView> = {}): SourcePublicationView => ({
  acknowledgedRequestGeneration: 1,
  dirty: false,
  dirtyGeneration: 1,
  lastOutcome: 'success',
  pendingDemand: false,
  publishedGeneration: 1,
  queued: false,
  requestedGeneration: 1,
  rtkCompletedGeneration: 1,
  rtkRequiredGeneration: 1,
  running: false,
  ...overrides,
});

describe('publication status presentation', () => {
  test('describes every publication state in plain reader-facing language', () => {
    expect(publicationStatus(publication({ running: true }))).toBe('Publishing stored data now.');
    expect(publicationStatus(publication({ queued: true }))).toBe('Publishing is queued.');
    expect(
      publicationStatus(publication({ pendingDemand: true, rtkCompletedGeneration: 1, rtkRequiredGeneration: 2 })),
    ).toBe('New data is waiting to be published once RTK savings enrichment catches up.');
    expect(publicationStatus(publication({ pendingDemand: true }))).toBe('New data is waiting to be published.');
    expect(publicationStatus(publication())).toBe('The report is up to date with everything collected.');
  });

  test('presents outcomes, pending requests, and RTK progress without engine jargon', () => {
    expect(publicationOutcomeLabel(publication({ lastOutcome: 'success' }))).toBe('Succeeded');
    expect(publicationOutcomeLabel(publication({ lastOutcome: 'failed' }))).toBe('Failed');
    expect(publicationOutcomeLabel(publication({ lastOutcome: 'not-run' }))).toBe('Not published yet');

    expect(pendingPublishRequests(publication({ acknowledgedRequestGeneration: 1, requestedGeneration: 3 }))).toBe(2);
    expect(pendingPublishRequests(publication())).toBe(0);
    expect(pendingPublishRequests(publication({ acknowledgedRequestGeneration: 3, requestedGeneration: 1 }))).toBe(0);

    expect(rtkDependencyStatus(publication())).toMatchObject({ behind: false, label: 'Up to date' });
    expect(rtkDependencyStatus(publication({ rtkCompletedGeneration: 1, rtkRequiredGeneration: 2 }))).toEqual({
      behind: true,
      label: 'Behind — publishing waits for it',
      title: 'RTK savings generation 1 of 2 required',
    });

    const visibleStrings = [
      publicationOutcomeLabel(publication({ lastOutcome: 'not-run' })),
      publicationStatus(publication()),
      rtkDependencyStatus(publication()).label,
    ];
    for (const value of visibleStrings) {
      expect(value).not.toMatch(PUBLICATION_JARGON_PATTERN);
    }
  });
});
