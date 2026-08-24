<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    muted,
    panel,
    panelHeader,
    panelSub,
    panelTitle,
    recordCard,
    recordLabel,
    recordSub,
    recordsGrid,
    recordsGridTriple,
    recordValue,
    topList,
    topMoney,
    topRank,
    topRow,
    topTitle,
  } from '@ai-usage/design-system/report';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import type { FocusedOverviewRecords, FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
  import { sessionDurationSemantics } from '../../../../session-analysis-model';
  import { fmtCount, fmtDateOnly, fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';

  const recordActionLabel = css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  });
  const disclosureIcon = css({
    color: 'accent',
    fontSize: '15px',
    fontWeight: 700,
    lineHeight: 1,
  });
  const srOnly = css({ srOnly: true });

  const unchangedItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;
  let {
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    presentSessionItem = unchangedItem,
    records,
    topSessions,
  }: {
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    records: FocusedOverviewRecords | null;
    topSessions: readonly FocusedOverviewSessionItem[];
  } = $props();
  const presentedRecords = $derived(
    records
      ? {
          ...records,
          longest: records.longest ? presentSessionItem(records.longest) : null,
          topCost: records.topCost ? presentSessionItem(records.topCost) : null,
        }
      : null,
  );
  // "Longest session" is a recorded duration whose meaning differs per harness, and
  // a campaign's is the root session's alone (plan 052). The card names which.
  const longestSemantics = $derived(
    presentedRecords?.longest
      ? sessionDurationSemantics(
          presentedRecords.longest.row.source?.harnessKey,
          presentedRecords.longest.kind === 'campaign' && presentedRecords.longest.sessionCount > 1,
        )
      : null,
  );
  const presentedTopSessions = $derived(topSessions.map(presentSessionItem));
  const topCostRepeatsFirstSession = $derived.by((): boolean => {
    const topCost = presentedRecords?.topCost;
    const firstSession = presentedTopSessions[0];
    return Boolean(
      topCost && firstSession && topCost.kind === firstSession.kind && topCost.row.rowId === firstSession.row.rowId,
    );
  });
  const recordCount = $derived(
    presentedRecords
      ? [
          presentedRecords.topCost !== null && !topCostRepeatsFirstSession,
          presentedRecords.longest !== null,
          presentedRecords.busiest !== null,
          presentedRecords.streak > 0 && presentedRecords.streakEnd !== null,
        ].filter(Boolean).length
      : 0,
  );
</script>

{#if presentedRecords}
  <div class={recordCount === 3 ? recordsGridTriple : recordsGrid} data-record-count={recordCount} data-records-grid>
    {#if presentedRecords.topCost !== null && !topCostRepeatsFirstSession}
      <button class={recordCard} onclick={() => onSelectSession(presentedRecords.topCost!)} type="button">
        <span class={srOnly}>Open details for top session {presentedRecords.topCost.label}. </span>
        <span class={cx(recordLabel, recordActionLabel)}
          >Top session <span aria-hidden="true" class={disclosureIcon}>↗</span></span
        >
        <span class={recordValue} title={apiValuePresentation(presentedRecords.topCost).title}
          >{apiValuePresentation(presentedRecords.topCost).label}</span
        >
        <span class={recordSub}>{presentedRecords.topCost.label}</span>
      </button>
    {/if}
    {#if presentedRecords.longest !== null}
      <button class={recordCard} onclick={() => onSelectSession(presentedRecords.longest!)} type="button">
        <span class={srOnly}
          >Open details for longest session {presentedRecords.longest.label} ({longestSemantics?.metricLabel}).
        </span>
        <span class={cx(recordLabel, recordActionLabel)}
          >Longest session <span aria-hidden="true" class={disclosureIcon}>↗</span></span
        >
        <span class={recordValue}>{fmtDuration(presentedRecords.longest.durationMs)}</span>
        <span class={recordSub} data-longest-session-semantic title={longestSemantics?.metricHint}
          >{presentedRecords.longest.label}
          · {longestSemantics?.metricLabel}</span
        >
      </button>
    {/if}
    {#if presentedRecords.busiest !== null}
      <button class={recordCard} onclick={() => onSelectDay(presentedRecords.busiest!.date)} type="button">
        <span class={srOnly}>Open activity for {fmtDateOnly(presentedRecords.busiest.date)}. </span>
        <span class={cx(recordLabel, recordActionLabel)}
          >Busiest day <span aria-hidden="true" class={disclosureIcon}>↗</span></span
        >
        <span class={recordValue}>{fmtMoney(presentedRecords.busiest.cost)}</span>
        <span class={recordSub}
          >{fmtDateOnly(presentedRecords.busiest.date)}
          · {fmtCount(presentedRecords.busiest.sessions, 'session')}</span
        >
      </button>
    {/if}
    {#if presentedRecords.streak > 0 && presentedRecords.streakEnd !== null}
      <button class={recordCard} onclick={() => onSelectDay(presentedRecords.streakEnd!)} type="button">
        <span class={srOnly}>Open activity for streak ending {fmtDateOnly(presentedRecords.streakEnd)}. </span>
        <span class={cx(recordLabel, recordActionLabel)}
          >Streak <span aria-hidden="true" class={disclosureIcon}>↗</span></span
        >
        <span class={recordValue}
          >{fmtNum(presentedRecords.streak)} {presentedRecords.streak === 1 ? 'day' : 'days'}</span
        >
        <span class={recordSub}>consecutive days with sessions, ending {fmtDateOnly(presentedRecords.streakEnd)}</span>
      </button>
    {/if}
  </div>
{/if}

{#if presentedTopSessions.length > 0}
  <section class={panel}>
    <header class={panelHeader}>
      <h3 class={panelTitle}>Top sessions</h3>
      <p class={panelSub}>
        The five highest estimated API-equivalent values for sessions or campaigns in range — click to inspect
      </p>
    </header>
    <div class={topList}>
      {#each presentedTopSessions as item, index (item.row.rowId)}
        <button class={topRow} onclick={() => onSelectSession(item)} type="button">
          <span class={srOnly}>Open details for {item.label}. </span>
          <span class={topRank}>{index + 1}</span>
          <span class={topTitle}>
            {item.label}
            {#if item.kind === 'campaign'}
              <span class={muted}> · Campaign · {fmtCount(item.sessionCount, 'session')}</span>
            {/if}
          </span>
          <HarnessBadge name={item.harness} />
          <span class={topMoney} title={apiValuePresentation(item).title}
            >{apiValuePresentation(item).label} <span aria-hidden="true" class={disclosureIcon}>↗</span></span
          >
        </button>
      {/each}
    </div>
  </section>
{/if}
