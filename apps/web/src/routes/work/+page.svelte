<script lang="ts">
  import WorkThreadsPage from '#lib/features/work/work-threads-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<WorkThreadsPage {data} />
