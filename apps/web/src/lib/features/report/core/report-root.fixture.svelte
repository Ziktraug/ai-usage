<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import {
    createSessionWindowAnchorOwner,
    provideSessionWindowAnchorOwner,
  } from '../../shell/session-window-anchor-context';
  import { provideSourceControlSummary } from '../../shell/source-control-summary-context';
  import SourceControlProvider from '../../sources/source-control-provider.svelte';
  import type { ReportPageData } from './report-bootstrap';
  import ReportRoot from './report-root.svelte';

  let { data }: { data: ReportPageData } = $props();

  // The report renders during SSR now, so it reaches the shell-owned contexts. Mirroring what
  // AppShell provides keeps this fixture representative of the tree the route actually renders.
  provideSessionWindowAnchorOwner(createSessionWindowAnchorOwner({ replace: () => undefined, state: () => ({}) }));
  provideSourceControlSummary(() => undefined);
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <SourceControlProvider runtimeMode={data.mode}>
    <ReportRoot {data} />
  </SourceControlProvider>
</WebQueryProvider>
