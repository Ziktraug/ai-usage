<script lang="ts">
  import type { WebQueryHydrationState } from '../../../query/client';
  import WebQueryProvider from '../../../query/provider.svelte';
  import SkillsShell from './skills-shell.svelte';

  let {
    hydrationState,
    pathname = '/skills/global/alpha-skill',
  }: {
    hydrationState: WebQueryHydrationState;
    pathname?: string;
  } = $props();
</script>

<WebQueryProvider {hydrationState}>
  <SkillsShell {hydrationState} {pathname} runtimeMode="e2e" />
</WebQueryProvider>
