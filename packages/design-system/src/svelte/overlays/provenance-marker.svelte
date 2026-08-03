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
    <span
      aria-label={title}
      class={hasWarning
        ? `${provenanceMarkerClass} ${provenanceMarkerWarningClass}`
        : provenanceMarkerClass}
      role="img"
    >
      {provenanceMarkerGlyph(facts)}
    </span>
  </Tooltip>
{/if}
