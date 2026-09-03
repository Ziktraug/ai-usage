<script lang="ts">
  import { meta } from '@ai-usage/design-system/report';
  import { type SkillObservationsView, skillObservationReadQualifications } from './model';

  let { view }: { view: SkillObservationsView | undefined } = $props();
  const qualifications = $derived(view === undefined ? [] : skillObservationReadQualifications(view));
</script>

{#if view?.producerCompletenessMissing}
  <p class={meta} data-skill-observations-collection-pending role="status">
    Producer collection state is missing, stale, disabled, or omitted from this response. Results remain provisional
    until every expected producer has current state.
  </p>
{/if}
{#each qualifications as qualification (qualification.channel)}
  <p class={meta} data-skill-observations-lower-bound={qualification.channel} role="status">
    {qualification.message}
  </p>
{/each}
{#if (view?.skipped ?? 0) > 0}
  <p class={meta} data-skill-observations-skipped role="status">
    {view?.skipped}
    stored observations could not be read and are not counted.
  </p>
{/if}
