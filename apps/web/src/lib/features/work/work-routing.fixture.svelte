<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import WebQueryProvider from '../../query/provider.svelte';
  import WorkRouting from './work-routing.svelte';

  let { routing }: { routing: ComponentProps<typeof WorkRouting> } = $props();
</script>

<WebQueryProvider>
  <WorkRouting {...routing} />
</WebQueryProvider>
