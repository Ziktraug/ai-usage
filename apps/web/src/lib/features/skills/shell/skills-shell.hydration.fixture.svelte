<script lang="ts">
  import { meta } from '@ai-usage/design-system/svelte';
  import type { WebQueryHydrationState } from '../../../query/client';
  import WebQueryProvider from '../../../query/provider.svelte';
  import SkillsShell from './skills-shell.svelte';

  let {
    hydrationState,
    navigationState = { aiUsageNavigationKey: 'skills-hydration-fixture' },
    source = 'not configured',
    pathname = '/skills/global/alpha-skill',
  }: {
    hydrationState: WebQueryHydrationState;
    navigationState?: App.PageState;
    source?: string;
    pathname?: string;
  } = $props();
</script>

<p class={meta}>Source {source}</p>
<WebQueryProvider {hydrationState}>
  <SkillsShell {hydrationState} {navigationState} {pathname} runtimeMode="e2e" />
</WebQueryProvider>
