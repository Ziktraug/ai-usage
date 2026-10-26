<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import WebQueryProvider from '../../query/provider.svelte';
  import WorkDelegations from './work-delegations.svelte';

  let { delegations }: { delegations: ComponentProps<typeof WorkDelegations> } = $props();
</script>

<WebQueryProvider>
  <WorkDelegations {...delegations} />
</WebQueryProvider>
