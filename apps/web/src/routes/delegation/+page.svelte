<script lang="ts">
  import DelegationPage from '#lib/features/delegation/delegation-page.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<DelegationPage {data} />
