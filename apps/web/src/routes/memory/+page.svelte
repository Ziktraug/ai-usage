<script lang="ts">
  import MemoryPage from '$lib/features/memory/memory-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<MemoryPage {data} />
