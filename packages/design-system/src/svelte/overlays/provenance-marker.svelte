<script lang="ts">
  import { type ProvenanceMarkerFact, provenanceMarkerGlyph, provenanceTitle } from './provenance';
  import { provenanceMarkerClass, provenanceMarkerWarningClass } from './styles';
  import Tooltip from './tooltip.svelte';

  interface Props {
    facts: readonly ProvenanceMarkerFact[];
  }

  let { facts }: Props = $props();
  const hasWarning = $derived(facts.some((fact) => fact.severity === 'warning'));
  const title = $derived(provenanceTitle(facts));
</script>

{#if facts.length > 0}
  <Tooltip content={title}>
    {#snippet trigger(_triggerProps)}
      <button
        {..._triggerProps}
        aria-label={title}
        class={hasWarning
          ? `${provenanceMarkerClass} ${provenanceMarkerWarningClass}`
          : provenanceMarkerClass}
        type="button"
      >
        {provenanceMarkerGlyph(facts)}
      </button>
    {/snippet}
  </Tooltip>
{/if}
