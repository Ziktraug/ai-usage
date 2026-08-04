<script lang="ts">
  import type { WebQueryHydrationState } from '../../../query/client';
  import WebQueryProvider from '../../../query/provider.svelte';
  import SkillsShell from './skills-shell.svelte';

  let {
    hydrationState,
    navigationState = { aiUsageNavigationKey: 'skills-hydration-fixture' },
    pathname = '/skills/global/alpha-skill',
  }: {
    hydrationState: WebQueryHydrationState;
    navigationState?: App.PageState;
    pathname?: string;
  } = $props();
</script>

<WebQueryProvider {hydrationState}>
  <SkillsShell {hydrationState} {navigationState} {pathname} runtimeMode="e2e" />
</WebQueryProvider>
