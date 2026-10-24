<script lang="ts">
  import MemoryPage from '#lib/features/memory/memory-page.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<MemoryPage address={page.url.href} {data} onNavigate={(href) => goto(href, { reset: false })} />
