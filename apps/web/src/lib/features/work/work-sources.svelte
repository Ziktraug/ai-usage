<script lang="ts">
  import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
  import { onMount } from 'svelte';
  import type { RuntimeMode } from '../../../runtime-mode';
  import { presentSourceState } from '../../../source-control-presentation-model';
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
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });
</script>

<details class={workPanel}>
  <summary class={workHeading}>
    Sources and limits
    <span class={workMuted}>
      {#if mode !== 'live'}
        Synthetic sources only.
      {:else if attentionCount === null}
        Coverage unavailable · collection {controlState.connection}.
      {:else}
        Collection {controlState.connection} · {attentionCount} sources have limits, older observations or no successful
        observation.
      {/if}
      Latest report publication: {generatedAt ?? 'unavailable'}.
    </span>
  </summary>
  <div class={workStack}>
    {#if support}
      {#if (support.support.warnings?.length ?? 0) > 0}
        <ul>
          {#each support.support.warnings ?? [] as warning}
            <li class={workMuted}>{warning.harness ?? 'Collection'}: {warning.message}</li>
          {/each}
        </ul>
      {/if}
      <p class={workMuted}>
        Stored report rows omitted: {support.support.omittedRows}. Additional warnings omitted:
        {support.truncation.warningsOmitted}. Additional provider observations omitted:
        {support.truncation.providerStatusesOmitted}. Other support entries omitted:
        {support.truncation.filterProjectOmitted +
          support.truncation.filterSinceOmitted +
          support.truncation.harnessOptionsOmitted +
          support.truncation.machineOptionsOmitted +
          support.truncation.providerRowsOmitted}.
      </p>
    {/if}
    <p class={workMuted}>
      Report published: {generatedAt ?? 'unavailable'}. Activity dates describe recorded history, not current progress.
      Sessions that ended are not necessarily delivered work. Shared checkouts and branches do not establish a shared
      topic.
    </p>
    {#if mode !== 'live'}
      <p class={workMuted}>Synthetic demonstration. No local history or live source status is read.</p>
    {:else}
      <p class={workMuted}>
        Collection connection: {controlState.connection}. Snapshot:
        {controlState.snapshot?.generatedAt ?? 'unavailable'}.
      </p>
      {#if controlState.snapshot}
        <ul class={workStack}>
          {#each controlState.snapshot.sources as source (source.id)}
            {@const presentation = presentSourceState(source)}
            <li class={workMuted}>
              <strong>{source.label}: {presentation.label}</strong>
              — {presentation.explanation}
              Last successful observation: {source.lastSuccessAt ?? 'unavailable'}.
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
      Native requests, unanswered proposals, GitHub and Jira outcomes are not collected for this view. Known waits are
      unavailable. No completion or authorization is inferred from their absence. Details are read only when opened;
      this list uses bounded stored metadata.
    </p>
  </div>
</details>
