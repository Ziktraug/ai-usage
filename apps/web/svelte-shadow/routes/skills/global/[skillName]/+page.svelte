<script lang="ts">
  import { page } from '$app/state';
  import DirtyNavigationFixture from '$lib/features/shell/dirty-navigation-fixture.svelte';
</script>

<div data-route-shell="skills-global-detail">
  {#if page.data.runtimeMode === 'e2e'}
    <DirtyNavigationFixture />
  {/if}
</div>
