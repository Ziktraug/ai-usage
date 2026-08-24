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
  /** False when the harness has no provider pairs or a single pair that repeats its own figures. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly group: AnalyticsGroup;
  /** The provider of a single mirroring pair, shown inline on the harness row instead of a child. */
  readonly soleProvider: string | null;
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

const MIRRORED_FIGURES = ['sessions', 'costSum', 'fresh', 'cache', 'priced'] as const;

/**
 * A harness whose only provider pair repeats the harness figures has nothing to disclose: the
 * child row would print the parent's numbers under a second name. Both group lists are computed
 * from the same visible rows, so this holds by construction today; the figure check guards the
 * day an aggregation diverges, in which case the disclosure comes back on its own.
 */
export const soleProviderMirroringHarness = (
  harness: AnalyticsGroup,
  children: readonly AnalyticsGroup[],
): string | null => {
  const [only] = children;
  if (children.length !== 1 || only === undefined) {
    return null;
  }
  return MIRRORED_FIGURES.every((figure) => only[figure] === harness[figure]) ? only.provider : null;
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
    const soleProvider = soleProviderMirroringHarness(group, allChildren);
    const expandable = soleProvider === null && allChildren.length > 0;
    const matchingChildren = allChildren.filter((child) => breakdownLabelMatchesSearch(child.provider, query));
    pairCount += searchActive ? matchingChildren.length : allChildren.length;
    let visibleChildren: readonly AnalyticsGroup[] = expandable ? matchingChildren : [];
    if (!searchActive) {
      visibleChildren = expandable && expandedHarnesses.includes(group.key) ? allChildren : [];
    }
    return {
      children: visibleChildren.map((child) => ({ group: child, label: child.provider })),
      controlsId: providerDisclosureId(group.key),
      expandable,
      expanded: visibleChildren.length > 0,
      group,
      soleProvider,
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
