import type { AnalyticsGroup } from '@ai-usage/core/analytics';
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
} from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import { createMemo, For, Show } from 'solid-js';
import {
  accentFill,
  fmtCompact,
  fmtMoney,
  fmtNum,
  fmtPct,
  harnessFillFor,
  UNKNOWN_PRICE_HINT,
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
                <Show when={props.onFilter} fallback={<div class={strongCell}>{group.key}</div>}>
                  <button class={groupKeyButton} type="button" onClick={() => props.onFilter?.(group.key)}>
                    {group.key}
                  </button>
                </Show>
                <div class={groupSub} title={groupFreshTitle(group)}>
                  {group.sessions} sess · {groupFreshLabel(group)} · {groupCacheLabel(group)}
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
                  <Show when={!analyticsGroupUnavailableOnly(group)} fallback={<UsageUnavailableCell />}>
                    <Show when={group.priced} fallback={<span title={UNKNOWN_PRICE_HINT}>—</span>}>
                      {fmtMoney(group.costSum)}
                    </Show>
                  </Show>
                </div>
                <div class={groupPct}>{fmtPct(group.costPercent)}</div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
