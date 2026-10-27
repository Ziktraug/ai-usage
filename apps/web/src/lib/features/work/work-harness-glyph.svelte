<script lang="ts">
  import { ProviderMark } from '@ai-usage/design-system/svelte';
  import { harnessGlyph, harnessHasMark } from './work-thread-model';

  /** The provider's own mark where one exists; letters only for harnesses that publish none. */
  let { harness, size = 12 }: { harness: string | null; size?: number } = $props();
</script>

{#if harness !== null && harnessHasMark(harness)}
  <ProviderMark name={harness} {size} />
{:else}
  {harnessGlyph(harness)}
{/if}
