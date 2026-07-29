import { SegmentedControl } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  barFill,
  barTrack,
  CellWithProvenance,
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
  strongCell,
} from '@ai-usage/design-system/report';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { PARTIALLY_MEASURED_LABEL, partiallyMeasuredApiPriceDescription } from '@ai-usage/report-core/provenance';
import { createMemo, For, Show } from 'solid-js';
import { type BreakdownSort, isBreakdownSort } from './dashboard-search';
import {
  breakdownBarPresentation,
  breakdownModelLabel,
  breakdownPriceState,
  breakdownPriceStateLabel,
  sortBreakdownGroups,
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
  const facts =
    state === 'partially measured'
      ? [
          {
            description: partiallyMeasuredApiPriceDescription(fmtCompact(props.group.unpricedFreshTokens)),
            label: PARTIALLY_MEASURED_LABEL,
            severity: 'warning' as const,
          },
        ]
      : [];
  return (
    <CellWithProvenance facts={facts}>
      <span title={presentation.title}>{presentation.label}</span>
    </CellWithProvenance>
  );
};

export const GroupPanel = (props: {
  title: string;
  groups: AnalyticsGroup[];
  countLabel: string;
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
  onSortChange: (value: BreakdownSort) => void;
  sort: BreakdownSort;
}) => {
  const maxCost = createMemo(() => Math.max(0, ...props.groups.map((group) => group.costSum)));
  const sortedGroups = createMemo(() => sortBreakdownGroups(props.groups, props.sort));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <SegmentedControl
          ariaLabel="Sort breakdown"
          items={BREAKDOWN_SORT_ITEMS}
          onValueChange={(value) => {
            if (isBreakdownSort(value)) {
              props.onSortChange(value);
            }
          }}
          value={props.sort}
        />
        <div class={groupCount} title={`${props.groups.length} ${props.countLabel}`}>
          {props.groups.length} {props.countLabel}
        </div>
      </div>
      <div class={groupRows}>
        <For each={sortedGroups()}>
          {(group) => (
            <div class={groupRow} data-price-state={groupBarPresentation(group, maxCost()).state}>
              <div>
                <Show
                  fallback={<div class={strongCell}>{groupDisplayKey(group, props.countLabel)}</div>}
                  when={props.onFilter}
                >
                  <button class={groupKeyButton} onClick={() => props.onFilter?.(group.key)} type="button">
                    {groupDisplayKey(group, props.countLabel)}
                  </button>
                </Show>
                <div class={groupSub} title={groupFreshTitle(group)}>
                  {group.sessions} sess{group.ambiguous ? ` · ${group.ambiguous} ambig` : ''} · {groupFreshLabel(group)}{' '}
                  · {groupCacheLabel(group)}
                  {groupPricingCoverage(group)}
                </div>
                <Show when={!analyticsGroupUnavailableOnly(group)}>
                  <div
                    aria-label={groupBarAriaLabel(group, maxCost())}
                    class={cx(
                      barTrack,
                      groupBarPresentation(group, maxCost()).state === 'partially measured'
                        ? partiallyMeasuredBarTrack
                        : undefined,
                    )}
                    data-price-bar={groupBarPresentation(group, maxCost()).state}
                    data-width-percent={String(groupBarPresentation(group, maxCost()).widthPercent ?? 0)}
                    role="img"
                  >
                    <div
                      class={cx(
                        barFill,
                        (props.harnessTones ? harnessFillFor(group.harness) : undefined) ?? accentFill,
                      )}
                      style={{ width: `${groupBarPresentation(group, maxCost()).widthPercent ?? 0}%` }}
                    />
                  </div>
                </Show>
              </div>
              <div class={right}>
                <div class={groupValue}>
                  <GroupApiValue group={group} />
                </div>
                <div class={groupPct} title={PRICED_SHARE_HINT}>
                  {fmtPct(group.costPercent)}
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
