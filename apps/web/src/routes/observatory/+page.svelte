<script lang="ts">
  import ObservatoryPage from '#lib/features/observatory/observatory-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>
<ObservatoryPage {data} />
