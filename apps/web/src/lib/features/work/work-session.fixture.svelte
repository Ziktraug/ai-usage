<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import WebQueryProvider from '../../query/provider.svelte';
  import WorkSession from './work-session.svelte';

  let { session }: { session: ComponentProps<typeof WorkSession> } = $props();
</script>

<WebQueryProvider>
  <WorkSession {...session} />
</WebQueryProvider>
