<script lang="ts">
  import WorkPage from '#lib/features/work/work-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<WorkPage {data} />
