<script lang="ts">
  import WebQueryProvider from '../../query/provider.svelte';
  import type { DelegationSettingsView } from './delegation-contract';
  import type { DelegationSection } from './delegation-model';
  import DelegationWorkbench from './delegation-workbench.svelte';

  let { section = 'routes', settings }: { section?: DelegationSection; settings: DelegationSettingsView } = $props();
</script>

<WebQueryProvider>
  <DelegationWorkbench
    client={null}
    onReload={() => Promise.resolve()}
    onSectionChange={() => undefined}
    {section}
    {settings}
  />
</WebQueryProvider>
