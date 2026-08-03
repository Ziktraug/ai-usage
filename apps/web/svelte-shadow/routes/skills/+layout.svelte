<script lang="ts">
  import RouteFrame from '$lib/features/shell/route-frame.svelte';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

<RouteFrame heading="Skill management"> {@render children()} </RouteFrame>
