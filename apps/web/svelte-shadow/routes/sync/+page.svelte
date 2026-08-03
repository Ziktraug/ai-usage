<script lang="ts">
  import { useSourceControl } from '$lib/features/sources/context.svelte';
  import SyncRoot from '$lib/features/sync/sync-root.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const sourceControl = useSourceControl();
  const connection = $derived(sourceControl.state().connection);
</script>

<SyncRoot {connection} {data} />
