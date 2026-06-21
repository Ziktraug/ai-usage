import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
import { css, cx } from '@ai-usage/design-system/css';
import { panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
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
  overflowWrap: 'anywhere',
});

const warningHarness = css({
  color: 'ink',
  fontWeight: 650,
});

export const ReportWarnings = (props: { warnings: UsageReportWarning[] | undefined }) => {
  const warnings = () => props.warnings ?? [];
  return (
    <Show when={warnings().length > 0}>
      <section class={cx(panel, warningPanel)}>
        <div class={panelHeader}>
          <h2 class={panelTitle}>Report warnings</h2>
          <p class={panelSub}>Some report inputs could not be fully processed. Totals use available rows only.</p>
        </div>
        <ul class={warningList}>
          <For each={warnings()}>
            {(warning) => (
              <li class={warningItem}>
                <Show when={warning.harness}>
                  {(harness) => <span class={warningHarness}>{harness()}: </span>}
                </Show>
                {warning.message}
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
};
