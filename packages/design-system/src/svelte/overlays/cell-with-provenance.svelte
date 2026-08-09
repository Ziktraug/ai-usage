<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ProvenanceMarkerFact } from './provenance';
  import ProvenanceMarker from './provenance-marker.svelte';
  import { provenanceCellClass } from './styles';

  interface Props {
    children: Snippet;
    facts: readonly ProvenanceMarkerFact[];
  }

  let { children, facts }: Props = $props();
</script>

{#if facts.length === 0}
  {@render children()}
{:else}
  <span class={provenanceCellClass}>
    <span>{@render children()}</span>
    <ProvenanceMarker {facts} />
  </span>
{/if}
