<script lang="ts">
  import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
  import { onMount } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { presentSourceState } from '../../../source-control-presentation-model';
  import { fmtDate } from '../../foundation/presentation/format';
  import { useSourceControl } from '../sources/context.svelte';
  import { workHeading, workLink, workMuted, workPanel, workStack } from './work-styles';

  let {
    mode,
    generatedAt,
    support,
  }: { mode: RuntimeMode; generatedAt: string | null; support: FocusedSupportResult | null } = $props();
  const control = useSourceControl();
  const controlState = $derived(control.state());
  let now = $state(Date.now());
  const attentionCount = $derived(
    controlState.snapshot?.sources.filter(
      (source) =>
        presentSourceState(source).tone !== 'ok' ||
        !source.lastSuccessAt ||
        now - Date.parse(source.lastSuccessAt) > source.cadenceMs * 2,
    ).length ?? null,
  );
  const omitted = $derived(
    support
      ? support.truncation.filterProjectOmitted +
          support.truncation.filterSinceOmitted +
          support.truncation.harnessOptionsOmitted +
          support.truncation.machineOptionsOmitted +
          support.truncation.providerRowsOmitted
      : 0,
  );
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });
</script>

<details class={workPanel} data-work-sources>
  <summary class={workHeading}>
    Sources and limits
    <span class={workMuted}>
      {#if mode !== 'live'}
        Synthetic sources only.
      {:else if attentionCount === null}
        Collection {controlState.connection}; coverage unavailable.
      {:else}
        Collection {controlState.connection} · {attentionCount} with limits or stale observations.
      {/if}
      Report published {fmtDate(generatedAt)}.
    </span>
  </summary>
  <div class={workStack}>
    {#if support && (support.support.warnings?.length ?? 0) > 0}
      <ul>
        {#each support.support.warnings ?? [] as warning}
          <li class={workMuted}>{warning.harness ?? 'Collection'}: {warning.message}</li>
        {/each}
      </ul>
    {/if}
    {#if support}
      <p class={workMuted}>
        Omitted from the served report: {support.support.omittedRows} rows,
        {support.truncation.warningsOmitted}
        warnings,
        {support.truncation.providerStatusesOmitted}
        provider observations, {omitted} other support entries.
      </p>
    {/if}
    <p class={workMuted}>
      Activity dates describe recorded history, not current progress. A session that ended is not necessarily delivered
      work; a shared checkout or branch does not make a shared topic. Declarations are the sessions’ own words at their
      last turn; facts are dated observations; nothing here infers completion or authorization.
    </p>
    {#if mode !== 'live'}
      <p class={workMuted}>Synthetic demonstration. No local history or live source status is read.</p>
    {:else}
      <p class={workMuted}>
        Collection connection: {controlState.connection}. Snapshot:
        {fmtDate(controlState.snapshot?.generatedAt ?? null)}.
      </p>
      {#if controlState.snapshot}
        <ul class={workStack}>
          {#each controlState.snapshot.sources as source (source.id)}
            {@const presentation = presentSourceState(source)}
            <li class={workMuted}>
              <strong>{source.label}: {presentation.label}</strong>
              — {presentation.explanation}
              Last successful observation: {fmtDate(source.lastSuccessAt ?? null)}.
              {#if source.lastSuccessAt && now - Date.parse(source.lastSuccessAt) > source.cadenceMs * 2}
                Older than two collection intervals; freshness is not established.
              {/if}
              {#if source.warnings.length > 0}
                Coverage warnings: {source.warnings.map((warning) => warning.code).join(', ')}.
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class={workMuted}>
          Collection coverage is unavailable. Missing observations do not mean there is nothing to do.
        </p>
      {/if}
      <a class={workLink} href="/sources">Open collection sources</a>
    {/if}
    <p class={workMuted}>
      Jira outcomes are not collected. Details are read only when opened; the lists use bounded stored metadata.
    </p>
  </div>
</details>
