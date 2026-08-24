<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const answer = css({ containerType: 'inline-size', display: 'grid', gap: { base: '14px', md: '18px' }, minW: 0 });
  const answerHeading = css({ display: 'grid', gap: '8px' });
  const qualification = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5, m: 0, maxW: '58ch' });
  const comparison = css({ color: 'ink', fontSize: '13px', fontWeight: 600, lineHeight: 1.45, m: 0 });
  const evidence = css({ display: 'grid', gap: '8px' });
  const activityCell = css({ minW: 0, gridColumn: { lg: '2' }, gridRow: { lg: '1 / span 2' } });
  const groupList = css({ display: 'grid', gap: '2px', listStyle: 'none', m: 0, p: 0 });
  const groupRow = css({
    alignItems: 'center',
    borderTop: '1px solid token(colors.line)',
    display: 'grid',
    gap: '8px',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    minH: { base: '36px', md: '42px' },
    py: { base: '4px', md: '6px' },
  });
  const groupName = css({ alignItems: 'center', display: 'flex', gap: '8px', minW: 0, overflowWrap: 'anywhere' });
  const groupShare = css({ color: 'muted', fontSize: '11px', textAlign: 'right', whiteSpace: 'nowrap' });
  const groupValue = css({ fontSize: '12px', fontWeight: 650, textAlign: 'right', whiteSpace: 'nowrap' });
  const metric = css({
    alignContent: 'start',
    borderTop: '1px solid token(colors.line)',
    display: 'grid',
    gap: '3px',
    m: 0,
    minW: 0,
    pt: '12px',
    '& dd, & dt': { m: 0 },
  });
  const metricValue = css({
    textStyle: 'numeric',
    fontSize: { base: '22px', md: '24px' },
    fontWeight: 650,
    lineHeight: 1.1,
  });
  const insight = css({
    borderInlineStart: '3px solid token(colors.lineStrong)',
    color: 'ink',
    display: 'grid',
    fontSize: '13px',
    gap: '4px',
    lineHeight: 1.55,
    m: 0,
    maxW: '78ch',
    ps: '14px',
  });
  const modelsHeader = css({
    alignItems: 'end',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 16px',
    justifyContent: 'space-between',
  });
  const modelsTitle = css({ fontSize: '14px', fontWeight: 650, m: 0 });
  const action = css({ minH: '44px', textDecoration: 'none' });
  const emptyState = css({ alignContent: 'center', display: 'grid', gap: '8px', justifyItems: 'start', minH: '180px' });
  const emptyTitle = css({ fontSize: '20px', fontWeight: 650, m: 0 });
  const srOnly = css({ srOnly: true });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    editorialSection,
    executiveCaption,
    executiveEssentialLabel,
    executiveGrid,
    ghostButton,
    metricStrip,
    numericDisplay,
    sectionDivider,
  } from '@ai-usage/design-system/report';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import type { ComponentProps } from 'svelte';
  import { fmtMoney, fmtPct } from '../../../foundation/presentation/format';
  import ActivityExplorer from '../range/activity-explorer.svelte';
  import type { ExecutiveOverviewModel } from './executive-overview-model';

  let {
    activity,
    draggedWindowApiValue = null,
    model,
    modelsHref,
    onClearFilters = () => undefined,
    onOpenModels,
  }: {
    activity?: ComponentProps<typeof ActivityExplorer>;
    draggedWindowApiValue?: number | null;
    model: ExecutiveOverviewModel;
    modelsHref: string;
    onClearFilters?: () => void;
    onOpenModels: () => void;
  } = $props();

  const displayedValue = $derived.by((): string => {
    if (draggedWindowApiValue === null) {
      return model.primary.value.label;
    }
    if (model.primary.provenance) {
      return draggedWindowApiValue > 0 ? `≥ ${fmtMoney(draggedWindowApiValue)}` : '—';
    }
    return fmtMoney(draggedWindowApiValue);
  });
  const previewAttributes = $derived(draggedWindowApiValue === null ? {} : ({ 'aria-busy': 'true' } as const));
  const comparisonText = $derived.by((): string | null => {
    const { comparison } = model.primary;
    if (comparison.delta) {
      const direction = comparison.delta.pct >= 0 ? 'higher' : 'lower';
      return `${fmtPct(Math.abs(comparison.delta.pct))} ${direction} than the previous equal-length period.`;
    }
    return comparison.explanation;
  });
  const comparisonCaveat = $derived(model.primary.comparison.caveat);
  const primaryQualification = $derived.by((): string => {
    const periodSentence = `This estimate covers work ${model.primary.periodScope}.`;
    const provenance = model.primary.provenance?.description;
    return provenance ? `${provenance} ${periodSentence}` : `Standard API-price estimate. ${periodSentence}`;
  });
  const openModels = (event: MouseEvent): void => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    onOpenModels();
  };
</script>

{#if model.emptyState}
  <section aria-labelledby="executive-empty-title" class={cx(editorialSection, emptyState)}>
    <h2 class={emptyTitle} id="executive-empty-title">{model.emptyState.title}</h2>
    <p class={qualification}>{model.emptyState.description}</p>
    {#if model.emptyState.actionIntent === 'open-sources'}
      <a class={cx(ghostButton, action)} href="/sources">{model.emptyState.actionLabel}</a>
    {:else}
      <button class={cx(ghostButton, action)} onclick={onClearFilters} type="button">
        {model.emptyState.actionLabel}
      </button>
    {/if}
  </section>
{:else}
  <section aria-labelledby="executive-overview-title" class={editorialSection}>
    <h2 class={srOnly} id="executive-overview-title">Executive overview</h2>
    <div class={executiveGrid}>
      <section aria-label="Estimated API-equivalent value" class={answer} data-executive-kpi>
        <div class={answerHeading} {...previewAttributes}>
          <span class={executiveEssentialLabel}>Estimated API-equivalent value</span>
          <strong class={numericDisplay} title={model.primary.value.title} style:--hero-chars={displayedValue.length}
            >{displayedValue}</strong
          >
          <p class={qualification}>{primaryQualification}</p>
          {#if comparisonText}
            <p class={comparison}>
              {comparisonText}
              {#if comparisonCaveat}
                <span class={qualification} data-period-comparison-caveat>{comparisonCaveat}</span>
              {/if}
            </p>
          {/if}
        </div>
      </section>

      {#if activity}
        <div class={activityCell}>
          <ActivityExplorer {...activity} />
        </div>
      {/if}

      <div class={evidence}>
        <h3 class={modelsTitle}>API value by harness</h3>
        <ul class={groupList}>
          {#each model.harnesses as harness (harness.group.key)}
            <li class={groupRow}>
              <span class={groupName}><HarnessBadge name={harness.group.label} /></span>
              <span class={groupShare}>{harness.shareLabel}</span>
              <strong class={groupValue} title={harness.value.title}>{harness.value.label}</strong>
            </li>
          {/each}
        </ul>
      </div>
    </div>

    <dl class={metricStrip} data-executive-metrics>
      {#each model.supportMetrics as supportMetric (supportMetric.key)}
        <div class={metric}>
          <dt class={executiveEssentialLabel}>{supportMetric.label}</dt>
          <dd class={metricValue}>{supportMetric.value}</dd>
          <dd class={executiveCaption}>{supportMetric.detail}</dd>
          {#if supportMetric.qualification}
            <dd class={executiveCaption}>{supportMetric.qualification}</dd>
          {/if}
        </div>
      {/each}
    </dl>

    {#if model.insight}
      <p class={cx(insight, sectionDivider)} data-period-insight>
        {#each model.insight.sentences as sentence}
          <span>{sentence}</span>
        {/each}
      </p>
    {/if}

    <section aria-labelledby="top-models-title" class={cx(editorialSection, sectionDivider)}>
      <div class={modelsHeader}>
        <div>
          <h3 class={modelsTitle} id="top-models-title">Top models</h3>
          <p class={executiveCaption}>Up to five models by known API-equivalent value.</p>
        </div>
        <a class={cx(ghostButton, action)} href={modelsHref} onclick={openModels}>Open Analysis → Models</a>
      </div>
      <ul class={groupList}>
        {#each model.models as modelGroup (modelGroup.group.key)}
          <li class={groupRow}>
            <span class={groupName}>{modelGroup.group.label}</span>
            <span class={groupShare}>{modelGroup.processedTokensLabel} tokens</span>
            <strong class={groupValue} title={modelGroup.value.title}>{modelGroup.value.label}</strong>
          </li>
        {/each}
      </ul>
    </section>
  </section>
{/if}
