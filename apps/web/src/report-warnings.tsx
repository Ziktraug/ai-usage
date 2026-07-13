import { css, cx } from '@ai-usage/design-system/css';
import { ghostButton, panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
import { For, Show } from 'solid-js';

const warningPanel = css({
  mt: '16px',
  borderColor: 'accent',
  bg: 'accentTint',
});

const warningList = css({
  m: 0,
  pl: '18px',
  display: 'grid',
  gap: '6px',
  color: 'muted',
  fontSize: '12px',
  maxW: '900px',
});

const warningItem = css({
  display: 'flex',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'space-between',
  overflowWrap: 'anywhere',
});

const warningMessage = css({
  minW: 0,
});

const warningHarness = css({
  color: 'ink',
  fontWeight: 650,
});

const warningCanCleanup = (warning: UsageReportWarning) =>
  warning.operation === 'projectGrouping' &&
  (warning.reason === 'unmatched-group' || warning.reason === 'partial-group') &&
  Boolean(warning.groupId);

export const ReportWarnings = (props: {
  cleaningProjectWarningGroupId?: string | undefined;
  omittedSupportItemCount?: number;
  onCleanupProjectWarning?: (warning: UsageReportWarning) => void;
  warnings: UsageReportWarning[] | undefined;
}) => {
  const warnings = () => props.warnings ?? [];
  return (
    <Show when={warnings().length > 0 || (props.omittedSupportItemCount ?? 0) > 0}>
      <section class={cx(panel, warningPanel)}>
        <div class={panelHeader}>
          <h2 class={panelTitle}>Report warnings</h2>
          <p class={panelSub}>Some report inputs could not be fully processed. Totals use available rows only.</p>
          <Show when={(props.omittedSupportItemCount ?? 0) > 0}>
            <p class={panelSub} role="status">
              {props.omittedSupportItemCount} additional support{' '}
              {props.omittedSupportItemCount === 1 ? 'item is' : 'items are'} omitted from this bounded summary. Exact
              report queries and complete exports remain available.
            </p>
          </Show>
        </div>
        <Show when={warnings().length > 0}>
          <ul class={warningList}>
            <For each={warnings()}>
              {(warning) => (
                <li class={warningItem}>
                  <span class={warningMessage}>
                    <Show when={warning.harness}>{(harness) => <span class={warningHarness}>{harness()}: </span>}</Show>
                    {warning.message}
                  </span>
                  <Show when={props.onCleanupProjectWarning && warningCanCleanup(warning)}>
                    <button
                      class={ghostButton}
                      disabled={props.cleaningProjectWarningGroupId === warning.groupId}
                      onClick={() => props.onCleanupProjectWarning?.(warning)}
                      type="button"
                    >
                      {props.cleaningProjectWarningGroupId === warning.groupId ? 'Cleaning…' : 'Cleanup'}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
};
