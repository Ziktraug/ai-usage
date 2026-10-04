<script lang="ts">
  import CampaignsPage from '$lib/features/campaigns/campaigns-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<CampaignsPage {data} />
