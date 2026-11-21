import type { TimelineDimension } from '../../../../overview-model';
import type { DashboardSearch } from '../../../foundation/dashboard/dashboard-search';

export const activeTimelineSeriesKeys = (search: DashboardSearch, dimension: TimelineDimension): readonly string[] => {
  if (dimension === 'harness') {
    return search.harness;
  }
  if (dimension === 'machine') {
    return search.machine;
  }
  if (dimension === 'model' || dimension === 'project' || dimension === 'provider') {
    const value = search.filters[dimension];
    return value === undefined ? [] : [value];
  }
  return [];
};
