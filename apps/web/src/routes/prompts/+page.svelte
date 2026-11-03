<script lang="ts">
  import PromptsPage from '#lib/features/prompts/prompts-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>
<PromptsPage {data} />
