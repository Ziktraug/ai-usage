import { type AnalyticsGroup, compareAnalyticsKeys } from '@ai-usage/report-core/analytics';
import type { AnalyticsExportRow } from '@ai-usage/report-core/csv';
import type { BreakdownSort } from '../../../../dashboard-search';
import {
  breakdownLabelMatchesSearch,
  filterAndSortBreakdownGroups,
  hasBreakdownSearchQuery,
} from '../../../../group-panel-presentation';

export interface HarnessProviderChild {
  readonly group: AnalyticsGroup;
  readonly label: string;
}

export interface HarnessProviderParent {
  readonly children: readonly HarnessProviderChild[];
  readonly controlsId: string;
  readonly expanded: boolean;
  readonly group: AnalyticsGroup;
}

export interface HarnessProviderView {
  readonly exportRows: readonly AnalyticsExportRow[];
  readonly pairCount: number;
  readonly parents: readonly HarnessProviderParent[];
  readonly searchActive: boolean;
}

const providerChildrenByHarness = (
  groups: readonly AnalyticsGroup[],
): ReadonlyMap<string, readonly AnalyticsGroup[]> => {
  const childrenByHarness = new Map<string, AnalyticsGroup[]>();
  for (const group of groups) {
    const children = childrenByHarness.get(group.harness) ?? [];
    children.push(group);
    childrenByHarness.set(group.harness, children);
  }
  for (const children of childrenByHarness.values()) {
    children.sort(
      (left, right) => right.sessions - left.sessions || compareAnalyticsKeys(left.provider, right.provider),
    );
  }
  return childrenByHarness;
};

export const providerDisclosureId = (harness: string): string =>
  `harness-provider-children-${encodeURIComponent(harness)}`;

export const harnessProviderView = (
  groups: readonly AnalyticsGroup[],
  harnessProviderGroups: readonly AnalyticsGroup[],
  query: string,
  sort: BreakdownSort,
  expandedHarnesses: readonly string[],
): HarnessProviderView => {
  const childrenByHarness = providerChildrenByHarness(harnessProviderGroups);
  const searchActive = hasBreakdownSearchQuery(query);
  const visibleGroups = filterAndSortBreakdownGroups(groups, query, sort, (group) =>
    [group.key, ...(childrenByHarness.get(group.key) ?? []).map(({ provider }) => provider)].join(' '),
  );
  let pairCount = 0;
  const parents = visibleGroups.map((group): HarnessProviderParent => {
    const allChildren = childrenByHarness.get(group.key) ?? [];
    const matchingChildren = allChildren.filter((child) => breakdownLabelMatchesSearch(child.provider, query));
    pairCount += searchActive ? matchingChildren.length : allChildren.length;
    let visibleChildren: readonly AnalyticsGroup[] = matchingChildren;
    if (!searchActive) {
      visibleChildren = expandedHarnesses.includes(group.key) ? allChildren : [];
    }
    return {
      children: visibleChildren.map((child) => ({ group: child, label: child.provider })),
      controlsId: providerDisclosureId(group.key),
      expanded: visibleChildren.length > 0,
      group,
    };
  });
  return {
    exportRows: parents.flatMap((parent) => [
      { group: parent.group, label: parent.group.key },
      ...parent.children.map(({ group, label }) => ({ group, label })),
    ]),
    pairCount,
    parents,
    searchActive,
  };
};

export const providerPairCountLabel = (count: number): string => `${count} provider ${count === 1 ? 'pair' : 'pairs'}`;
