<script lang="ts">
  import { meta } from '@ai-usage/design-system/report';
  import type { SkillObservationsView } from './model';

  let { view }: { view: SkillObservationsView | undefined } = $props();
</script>

{#if view?.producerCompletenessMissing}
  <p class={meta} data-skill-observations-collection-pending role="status">
    Producer collection state is missing, stale, disabled, or omitted from this response. Results remain provisional
    until every expected producer has current state.
  </p>
{/if}
{#if view?.lowerBound}
  <p
    class={meta}
    data-skill-observations-lower-bound={view.onlyExposureTruncated ? 'exposure' : 'invocations'}
    role="status"
  >
    {#if view.onlyExposureTruncated}
      Exposure evidence is incomplete, so <em>exposed</em> counts below are lower bounds. Invocation verdicts are not
      affected.
    {:else}
      Observation evidence is incomplete, so declared, inferred, and exposed counts below are lower bounds.
      Absence-based verdicts are provisional.
    {/if}
  </p>
{/if}
{#if (view?.skipped ?? 0) > 0}
  <p class={meta} data-skill-observations-skipped role="status">
    {view?.skipped}
    stored observations could not be read and are not counted.
  </p>
{/if}
