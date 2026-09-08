<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { ProjectsPageData } from './projects-load';
  import ProjectsPage from './projects-page.svelte';

  let { data }: { data: ProjectsPageData } = $props();
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <ProjectsPage {data} />
</WebQueryProvider>
