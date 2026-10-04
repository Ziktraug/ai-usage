<script lang="ts">
  import CampaignsPage from '$lib/features/campaigns/campaigns-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let campaigns = $state<CampaignsPage>();
  export const snapshot = {
    capture: () => campaigns?.capture(),
    restore: (saved: ReturnType<CampaignsPage['capture']> | undefined) => {
      if (saved) {
        campaigns?.restore(saved);
      }
    },
  };
</script>

<CampaignsPage {data} bind:this={campaigns} />
