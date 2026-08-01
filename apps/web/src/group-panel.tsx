import { SegmentedControl } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  actionRow,
  barFill,
  barTrack,
  groupCount,
  groupHeader,
  groupKeyButton,
  groupPanel,
  groupPct,
  groupRow,
  groupRows,
  groupSub,
  groupTitle,
  groupValue,
  right,
  searchInput,
  strongCell,
  unavailableText,
} from '@ai-usage/design-system/report';
import { type AnalyticsGroup, compareAnalyticsKeys } from '@ai-usage/report-core/analytics';
import { PARTIALLY_MEASURED_LABEL } from '@ai-usage/report-core/provenance';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { type BreakdownSort, isBreakdownSort } from './dashboard-search';
import {
  breakdownBarPresentation,
  breakdownLabelMatchesSearch,
  breakdownModelLabel,
  breakdownPriceState,
  breakdownPriceStateLabel,
  filterAndSortBreakdownGroups,
  hasBreakdownSearchQuery,
} from './group-panel-presentation';
import {
  accentFill,
  aggregateApiValuePresentation,
  fmtCompact,
  fmtNum,
  fmtPct,
  harnessFillFor,
  USAGE_UNAVAILABLE_HINT,
} from './shared';

const analyticsGroupUnavailableOnly = (group: AnalyticsGroup) => group.usageUnavailable === group.sessions;
const groupFreshLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? '— fresh' : `${fmtCompact(group.fresh)} fresh`;
const groupFreshTitle = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`;
const groupCacheLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? '— cache' : `${fmtPct(group.cacheHitPct)} cache`;
const groupSessionSummary = (group: AnalyticsGroup): string =>
  `${fmtNum(group.sessions)} ${group.sessions === 1 ? 'session' : 'sessions'}${
    group.ambiguous ? ` · ${fmtNum(group.ambiguous)} ambiguous` : ''
  }`;
const groupPricingCoverage = (group: AnalyticsGroup) =>
  group.unpriced > 0
    ? ` · ${PARTIALLY_MEASURED_LABEL} (${fmtNum(group.priced)}/${fmtNum(group.sessions)} fully priced)`
    : '';
const PRICED_SHARE_HINT =
  'Share of the known API-value subtotal in this breakdown; ≥ values include lower bounds from incomplete pricing';
const BREAKDOWN_SORT_ITEMS = [
  { label: 'Value', value: 'value' },
  { label: 'Tokens', value: 'tokens' },
  { label: 'Sessions', value: 'sessions' },
] as const;
const partiallyMeasuredBarTrack = css({
  border: '1px dashed token(colors.accent)',
  bg: 'surfaceMuted',
  boxSizing: 'border-box',
});
const hierarchyBlock = css({
  borderBottom: '1px solid token(colors.line)',
  _last: {
    borderBottom: '0',
  },
});
const hierarchyRow = css({
  borderBottom: '0',
});
const hierarchyChildren = css({
  minW: 0,
  border: '0',
  m: '0',
  p: '0',
});
const hierarchyChildRow = css({
  borderTop: '1px solid token(colors.line)',
  bg: 'surfaceMuted',
  pl: { base: '48px', md: '56px' },
});
const hierarchyKey = css({
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
});
const hierarchyToggle = css({
  appearance: 'none',
  display: 'inline-grid',
  placeItems: 'center',
  minH: '32px',
  minW: '32px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  p: '0',
  bg: 'transparent',
  color: 'muted',
  cursor: 'pointer',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});
const groupBarPresentation = (group: AnalyticsGroup, maxKnownCost: number) =>
  breakdownBarPresentation({
    knownCost: group.costSum,
    maxKnownCost,
    unpricedCount: group.unpriced,
    usageUnavailable: analyticsGroupUnavailableOnly(group),
  });
const groupDisplayKey = (group: AnalyticsGroup, countLabel: string) =>
  countLabel === 'models' ? breakdownModelLabel(group.key) : group.key;
const groupBarAriaLabel = (group: AnalyticsGroup, maxKnownCost: number) =>
  `${breakdownPriceStateLabel(groupBarPresentation(group, maxKnownCost).state)} API-value bar`;

interface AnalyticsGroupContentProps {
  children: JSX.Element;
  group: AnalyticsGroup;
  harnessTones: boolean;
  maxCost: number;
}

const AnalyticsGroupContent = (props: AnalyticsGroupContentProps) => (
  <>
    <div>
      {props.children}
      <div class={groupSub} title={groupFreshTitle(props.group)}>
        {groupSessionSummary(props.group)} · {groupFreshLabel(props.group)} · {groupCacheLabel(props.group)}
        {groupPricingCoverage(props.group)}
      </div>
      <Show when={!analyticsGroupUnavailableOnly(props.group)}>
        <div
          aria-label={groupBarAriaLabel(props.group, props.maxCost)}
          class={cx(
            barTrack,
            groupBarPresentation(props.group, props.maxCost).state === 'partially measured'
              ? partiallyMeasuredBarTrack
              : undefined,
          )}
          data-price-bar={groupBarPresentation(props.group, props.maxCost).state}
          data-width-percent={String(groupBarPresentation(props.group, props.maxCost).widthPercent ?? 0)}
          role="img"
        >
          <div
            class={cx(barFill, (props.harnessTones ? harnessFillFor(props.group.harness) : undefined) ?? accentFill)}
            style={{ width: `${groupBarPresentation(props.group, props.maxCost).widthPercent ?? 0}%` }}
          />
        </div>
      </Show>
    </div>
    <div class={right}>
      <div class={groupValue}>
        <GroupApiValue group={props.group} />
      </div>
      <div class={groupPct} title={PRICED_SHARE_HINT}>
        {fmtPct(props.group.costPercent)}
      </div>
    </div>
  </>
);

const GroupApiValue = (props: { group: AnalyticsGroup }) => {
  const state = breakdownPriceState({
    knownCost: props.group.costSum,
    unpricedCount: props.group.unpriced,
    usageUnavailable: analyticsGroupUnavailableOnly(props.group),
  });
  if (state === 'unavailable') {
    return <span title={USAGE_UNAVAILABLE_HINT}>—</span>;
  }
  const presentation = aggregateApiValuePresentation({
    knownCost: props.group.costSum,
    state,
    unpricedFreshTokens: props.group.unpricedFreshTokens,
  });
  return <span title={presentation.title}>{presentation.label}</span>;
};

export const exactGroupFilterHandler =
  (filter: (value: string) => void, value: string): (() => void) =>
  () =>
    filter(value);

interface HarnessProviderDisclosure {
  controlsId: string;
  expanded: boolean;
  onToggle: () => void;
}

interface HarnessProviderGroupRowProps {
  child: boolean;
  disclosure?: HarnessProviderDisclosure;
  filterValue: string;
  group: AnalyticsGroup;
  label: string;
  maxCost: number;
  onFilter: (value: string) => void;
}

const HarnessProviderGroupRow = (props: HarnessProviderGroupRowProps) => (
  <div
    class={cx(groupRow, hierarchyRow, props.child ? hierarchyChildRow : undefined)}
    data-harness-total={props.child ? undefined : props.group.harness}
    data-price-state={groupBarPresentation(props.group, props.maxCost).state}
    data-provider-child={props.child ? props.group.provider : undefined}
  >
    <AnalyticsGroupContent group={props.group} harnessTones maxCost={props.maxCost}>
      <div class={hierarchyKey}>
        <Show when={props.disclosure}>
          {(disclosure) => (
            <button
              aria-controls={disclosure().controlsId}
              aria-expanded={disclosure().expanded}
              aria-label={`${disclosure().expanded ? 'Collapse' : 'Expand'} providers for ${props.group.harness}`}
              class={hierarchyToggle}
              onClick={disclosure().onToggle}
              type="button"
            >
              <span aria-hidden="true">{disclosure().expanded ? '−' : '+'}</span>
            </button>
          )}
        </Show>
        <button
          class={groupKeyButton}
          onClick={exactGroupFilterHandler(props.onFilter, props.filterValue)}
          type="button"
        >
          {props.label}
        </button>
      </div>
    </AnalyticsGroupContent>
  </div>
);

interface GroupPanelProps {
  countLabel: string;
  groups: AnalyticsGroup[];
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
  onSortChange: (value: BreakdownSort) => void;
  renderActions?: (groups: readonly AnalyticsGroup[]) => JSX.Element;
  sort: BreakdownSort;
  title: string;
}

interface GroupPanelViewProps extends GroupPanelProps {
  onSearchQueryChange: (value: string) => void;
  searchQuery: string;
}

interface BreakdownPanelShellProps {
  actions?: JSX.Element;
  children: JSX.Element;
  count: number;
  countLabel: string;
  onSearchQueryChange: (value: string) => void;
  searchQuery: string;
  sortControl?: JSX.Element;
  title: string;
}

const BreakdownPanelShell = (props: BreakdownPanelShellProps) => (
  <div class={groupPanel}>
    <div class={groupHeader}>
      <div class={groupTitle}>{props.title}</div>
      <div class={groupCount} title={`${props.count} ${props.countLabel}`}>
        {props.count} {props.countLabel}
      </div>
      <div class={actionRow} style={{ 'grid-column': '1 / -1' }}>
        <input
          aria-label="Search this breakdown"
          class={searchInput}
          onInput={(event) => props.onSearchQueryChange(event.currentTarget.value)}
          placeholder="Search this breakdown"
          type="search"
          value={props.searchQuery}
        />
        {props.sortControl}
        {props.actions}
      </div>
    </div>
    <div class={groupRows}>
      <Show
        fallback={
          <div class={groupRow} role="status">
            <div class={unavailableText}>No breakdown rows match this search</div>
          </div>
        }
        when={props.count > 0}
      >
        {props.children}
      </Show>
    </div>
  </div>
);

export const GroupPanelView = (props: GroupPanelViewProps) => {
  const visibleGroups = createMemo(() =>
    filterAndSortBreakdownGroups(props.groups, props.searchQuery, props.sort, (group) =>
      groupDisplayKey(group, props.countLabel),
    ),
  );
  const maxCost = createMemo(() => Math.max(0, ...visibleGroups().map((group) => group.costSum)));

  return (
    <BreakdownPanelShell
      actions={props.renderActions?.(visibleGroups())}
      count={visibleGroups().length}
      countLabel={props.countLabel}
      onSearchQueryChange={props.onSearchQueryChange}
      searchQuery={props.searchQuery}
      sortControl={
        <SegmentedControl
          ariaLabel="Sort breakdown"
          defaultValue="value"
          items={BREAKDOWN_SORT_ITEMS}
          onValueChange={(value) => {
            if (isBreakdownSort(value)) {
              props.onSortChange(value);
            }
          }}
          value={props.sort}
        />
      }
      title={props.title}
    >
      <For each={visibleGroups()}>
        {(group) => (
          <div class={groupRow} data-price-state={groupBarPresentation(group, maxCost()).state}>
            <AnalyticsGroupContent group={group} harnessTones={props.harnessTones ?? false} maxCost={maxCost()}>
              <Show
                fallback={<div class={strongCell}>{groupDisplayKey(group, props.countLabel)}</div>}
                when={props.onFilter}
              >
                <button class={groupKeyButton} onClick={() => props.onFilter?.(group.key)} type="button">
                  {groupDisplayKey(group, props.countLabel)}
                </button>
              </Show>
            </AnalyticsGroupContent>
          </div>
        )}
      </For>
    </BreakdownPanelShell>
  );
};

export const GroupPanel = (props: GroupPanelProps) => {
  const [searchQuery, setSearchQuery] = createSignal('');

  return (
    <GroupPanelView
      countLabel={props.countLabel}
      groups={props.groups}
      {...(props.harnessTones === undefined ? {} : { harnessTones: props.harnessTones })}
      {...(props.onFilter ? { onFilter: props.onFilter } : {})}
      onSearchQueryChange={setSearchQuery}
      onSortChange={props.onSortChange}
      {...(props.renderActions ? { renderActions: props.renderActions } : {})}
      searchQuery={searchQuery()}
      sort={props.sort}
      title={props.title}
    />
  );
};

interface HarnessProviderPanelProps {
  groups: AnalyticsGroup[];
  harnessProviderGroups: AnalyticsGroup[];
  onHarnessFilter: (value: string) => void;
  onProviderFilter: (value: string) => void;
  renderActions?: (rows: readonly VisibleBreakdownGroup[]) => JSX.Element;
}

export interface VisibleBreakdownGroup {
  group: AnalyticsGroup;
  label: string;
}

interface HarnessProviderPanelViewProps extends HarnessProviderPanelProps {
  expandedHarnesses: readonly string[];
  onSearchQueryChange: (value: string) => void;
  onToggleHarness: (value: string) => void;
  searchQuery: string;
}

const providerChildrenByHarness = (groups: readonly AnalyticsGroup[]): Map<string, AnalyticsGroup[]> => {
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

const providerDisclosureId = (harness: string): string => `harness-provider-children-${encodeURIComponent(harness)}`;

const pairCountLabel = (count: number): string => `${count} provider ${count === 1 ? 'pair' : 'pairs'}`;

export const HarnessProviderPanelView = (props: HarnessProviderPanelViewProps) => {
  const childrenByHarness = createMemo(() => providerChildrenByHarness(props.harnessProviderGroups));
  const searchActive = createMemo(() => hasBreakdownSearchQuery(props.searchQuery));
  const matchingChildrenFor = (harness: string): AnalyticsGroup[] =>
    (childrenByHarness().get(harness) ?? []).filter((child) =>
      breakdownLabelMatchesSearch(child.provider, props.searchQuery),
    );
  const visibleChildrenFor = (harness: string): AnalyticsGroup[] => {
    if (searchActive()) {
      return matchingChildrenFor(harness);
    }
    if (!props.expandedHarnesses.includes(harness)) {
      return [];
    }
    return childrenByHarness().get(harness) ?? [];
  };
  const visibleGroups = createMemo(() =>
    filterAndSortBreakdownGroups(props.groups, props.searchQuery, 'value', (group) =>
      [group.key, ...(childrenByHarness().get(group.key) ?? []).map(({ provider }) => provider)].join(' '),
    ),
  );
  const maxCost = createMemo(() => Math.max(0, ...visibleGroups().map(({ costSum }) => costSum)));
  const visiblePairCount = createMemo(() =>
    visibleGroups().reduce(
      (count, group) =>
        count +
        (searchActive() ? matchingChildrenFor(group.key).length : (childrenByHarness().get(group.key)?.length ?? 0)),
      0,
    ),
  );
  const visibleExportRows = createMemo(() => {
    const rows: VisibleBreakdownGroup[] = [];
    for (const group of visibleGroups()) {
      rows.push({ group, label: group.key });
      const children = visibleChildrenFor(group.key);
      if (children.length === 0) {
        continue;
      }
      for (const child of children) {
        rows.push({ group: child, label: child.provider });
      }
    }
    return rows;
  });

  return (
    <BreakdownPanelShell
      actions={props.renderActions?.(visibleExportRows())}
      count={visibleGroups().length}
      countLabel={`harnesses · ${pairCountLabel(visiblePairCount())}`}
      onSearchQueryChange={props.onSearchQueryChange}
      searchQuery={props.searchQuery}
      title="Harnesses & providers"
    >
      <For each={visibleGroups()}>
        {(group) => {
          const visibleChildren = () => visibleChildrenFor(group.key);
          const expanded = () => visibleChildren().length > 0;
          const controlsId = providerDisclosureId(group.key);
          return (
            <div class={hierarchyBlock}>
              <HarnessProviderGroupRow
                child={false}
                {...(searchActive()
                  ? {}
                  : {
                      disclosure: {
                        controlsId,
                        expanded: expanded(),
                        onToggle: exactGroupFilterHandler(props.onToggleHarness, group.key),
                      },
                    })}
                filterValue={group.key}
                group={group}
                label={group.key}
                maxCost={maxCost()}
                onFilter={props.onHarnessFilter}
              />
              <Show when={visibleChildren().length > 0}>
                <fieldset aria-label={`Providers for ${group.key}`} class={hierarchyChildren} id={controlsId}>
                  <For each={visibleChildren()}>
                    {(child) => (
                      <HarnessProviderGroupRow
                        child
                        filterValue={child.provider}
                        group={child}
                        label={child.provider}
                        maxCost={maxCost()}
                        onFilter={props.onProviderFilter}
                      />
                    )}
                  </For>
                </fieldset>
              </Show>
            </div>
          );
        }}
      </For>
    </BreakdownPanelShell>
  );
};

export const HarnessProviderPanel = (props: HarnessProviderPanelProps) => {
  const [expandedHarnesses, setExpandedHarnesses] = createSignal<readonly string[]>([]);
  const [searchQuery, setSearchQuery] = createSignal('');
  const toggleHarness = (harness: string) =>
    setExpandedHarnesses((current) =>
      current.includes(harness) ? current.filter((value) => value !== harness) : [...current, harness],
    );

  return (
    <HarnessProviderPanelView
      expandedHarnesses={expandedHarnesses()}
      groups={props.groups}
      harnessProviderGroups={props.harnessProviderGroups}
      onHarnessFilter={props.onHarnessFilter}
      onProviderFilter={props.onProviderFilter}
      onSearchQueryChange={setSearchQuery}
      {...(props.renderActions ? { renderActions: props.renderActions } : {})}
      onToggleHarness={toggleHarness}
      searchQuery={searchQuery()}
    />
  );
};
