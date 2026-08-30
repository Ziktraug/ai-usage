<script lang="ts">
  import ProjectsPage from '$lib/features/projects/projects-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<ProjectsPage {data} />
