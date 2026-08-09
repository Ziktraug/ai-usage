import { describe, expect, test } from 'bun:test';
import { dashboardSearchDefaultsFor } from '../../../../dashboard-search';
import { activeTimelineSeriesKeys } from './active-timeline-series';

const search = {
  ...dashboardSearchDefaultsFor('cost'),
  filters: { campaign: 'campaign-1', model: 'model-1', project: 'project-1', provider: 'provider-1' },
  harness: ['claude-code'],
  machine: ['machine-1'],
};

describe('active timeline series', () => {
  test('maps URL-backed dimensions to active keys', () => {
    expect(activeTimelineSeriesKeys(search, 'harness')).toEqual(['claude-code']);
    expect(activeTimelineSeriesKeys(search, 'machine')).toEqual(['machine-1']);
    expect(activeTimelineSeriesKeys(search, 'model')).toEqual(['model-1']);
    expect(activeTimelineSeriesKeys(search, 'project')).toEqual(['project-1']);
    expect(activeTimelineSeriesKeys(search, 'provider')).toEqual(['provider-1']);
  });

  test('leaves dimensions without one series identity inactive', () => {
    expect(activeTimelineSeriesKeys(search, 'campaign')).toEqual([]);
    expect(activeTimelineSeriesKeys(search, 'origin')).toEqual([]);
  });
});
