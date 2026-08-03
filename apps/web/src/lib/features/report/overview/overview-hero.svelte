<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const hero = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1.5fr) minmax(220px, 1fr)' },
    gap: '18px',
    p: { base: '18px', md: '24px' },
    border: '1px solid token(colors.line)',
    borderRadius: 'lg',
    bg: 'surface',
    boxShadow: 'card',
  });
  const eyebrow = css({ color: 'muted', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' });
  const value = css({ mt: '8px', fontSize: { base: '34px', md: '44px' }, fontWeight: 700, letterSpacing: '-0.03em' });
  const qualification = css({ mt: '8px', color: 'muted', fontSize: '12px' });
  const side = css({ display: 'grid', alignContent: 'center', gap: '12px' });
  const item = css({ display: 'grid', gap: '3px' });
  const label = css({ color: 'muted', fontSize: '11px', textTransform: 'uppercase' });
  const amount = css({ fontSize: '17px', fontWeight: 650, textStyle: 'numeric' });
</script>

<script lang="ts">
  import type { FocusedReportSummary } from '@ai-usage/report-core/focused-report-query';
  import { fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { aggregateApiValuePresentation } from '../../../foundation/presentation/report-value';

  let { summary }: { summary: FocusedReportSummary } = $props();
  const apiValue = $derived(aggregateApiValuePresentation(summary.priceMeasurement));
  const actualKnownSessions = $derived(Math.max(0, summary.sessionCount - summary.unknownActual));
</script>

<section aria-label="Estimated API-equivalent value" class={hero}>
  <div>
    <p class={eyebrow}>Estimated API-equivalent value</p>
    <p class={value}>{apiValue.label}</p>
    <p class={qualification}>{apiValue.title}</p>
  </div>
  <dl class={side}>
    <div class={item}>
      <dt class={label}>Reported actual spend</dt>
      <dd class={amount} data-reported-actual-spend>
        {summary.unknownActual === summary.sessionCount ? '—' : fmtMoney(summary.actualCost)}
      </dd>
      <p class={qualification} data-spend-coverage-legend>
        {fmtNum(actualKnownSessions)}
        of {fmtNum(summary.sessionCount)} sessions report actual spend
      </p>
    </div>
    <div class={item}>
      <dt class={label}>Subscription value</dt>
      <dd class={amount}>{fmtMoney(summary.costQuota)}</dd>
    </div>
  </dl>
</section>
