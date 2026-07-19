import { cx } from '@ai-usage/design-system/css';
import {
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
  strongCell,
} from '@ai-usage/design-system/report';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { createMemo, For, Show } from 'solid-js';
import {
  accentFill,
  apiValuePresentation,
  fmtCompact,
  fmtNum,
  fmtPct,
  harnessFillFor,
  USAGE_UNAVAILABLE_HINT,
  UsageUnavailableCell,
} from './shared';

const analyticsGroupUnavailableOnly = (group: AnalyticsGroup) => group.usageUnavailable === group.sessions;
const groupFreshLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a fresh' : `${fmtCompact(group.fresh)} fresh`;
const groupFreshTitle = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`;
const groupCacheLabel = (group: AnalyticsGroup) =>
  analyticsGroupUnavailableOnly(group) ? 'n/a cache' : `${fmtPct(group.cacheHitPct)} cache`;
const groupPricingCoverage = (group: AnalyticsGroup) =>
  group.unpriced > 0 ? ` · ${fmtNum(group.priced)}/${fmtNum(group.sessions)} fully priced` : '';
const PRICED_SHARE_HINT =
  'Share of the known API-value subtotal in this breakdown; ≥ values include lower bounds from incomplete pricing';

const GroupApiValue = (props: { group: AnalyticsGroup }) => {
  const presentation = apiValuePresentation({
    costApprox: props.group.costSum,
    costKnown: props.group.unpriced === 0,
  });
  return <span title={presentation.title}>{presentation.label}</span>;
};

export const GroupPanel = (props: {
  title: string;
  groups: AnalyticsGroup[];
  countLabel: string;
  harnessTones?: boolean;
  onFilter?: (value: string) => void;
}) => {
  const maxCost = createMemo(() => Math.max(1, ...props.groups.map((group) => group.costSum)));
  return (
    <div class={groupPanel}>
      <div class={groupHeader}>
        <div class={groupTitle}>{props.title}</div>
        <div class={groupCount} title={`${props.groups.length} ${props.countLabel}`}>
          {props.groups.length} {props.countLabel}
        </div>
      </div>
      <div class={groupRows}>
        <For each={props.groups}>
          {(group) => (
            <div class={groupRow}>
              <div>
                <Show fallback={<div class={strongCell}>{group.key}</div>} when={props.onFilter}>
                  <button class={groupKeyButton} onClick={() => props.onFilter?.(group.key)} type="button">
                    {group.key}
                  </button>
                </Show>
                <div class={groupSub} title={groupFreshTitle(group)}>
                  {group.sessions} sess{group.ambiguous ? ` · ${group.ambiguous} ambig` : ''} · {groupFreshLabel(group)}{' '}
                  · {groupCacheLabel(group)}
                  {groupPricingCoverage(group)}
                </div>
                <div class={barTrack}>
                  <div
                    class={cx(barFill, (props.harnessTones ? harnessFillFor(group.harness) : undefined) ?? accentFill)}
                    style={{
                      width: analyticsGroupUnavailableOnly(group)
                        ? '0%'
                        : `${Math.max(3, (group.costSum / maxCost()) * 100)}%`,
                    }}
                  />
                </div>
              </div>
              <div class={right}>
                <div class={groupValue}>
                  <Show fallback={<UsageUnavailableCell />} when={!analyticsGroupUnavailableOnly(group)}>
                    <GroupApiValue group={group} />
                  </Show>
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
