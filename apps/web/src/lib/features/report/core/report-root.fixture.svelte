<script lang="ts">
  import WebQueryProvider from '../../../query/provider.svelte';
  import { createShellNavigationOwner, provideShellNavigationOwner } from '../../shell/navigation-owner-context';
  import {
    createSessionWindowAnchorOwner,
    provideSessionWindowAnchorOwner,
  } from '../../shell/session-window-anchor-context';
  import SourceControlProvider from '../../sources/source-control-provider.svelte';
  import type { ReportPageData } from './report-bootstrap';
  import ReportRoot from './report-root.svelte';

  let { data }: { data: ReportPageData } = $props();

  // The report renders during SSR now, so it reaches the shell-owned contexts. Mirroring what
  // AppShell provides keeps this fixture representative of the tree the route actually renders.
  provideShellNavigationOwner(
    createShellNavigationOwner({
      currentUrl: () => new URL('http://report.invalid/'),
      goto: () => Promise.reject(new Error('Server rendering must not navigate')),
    }),
  );
  provideSessionWindowAnchorOwner(createSessionWindowAnchorOwner({ replace: () => undefined, state: () => ({}) }));
</script>

<WebQueryProvider hydrationState={data.queryState}>
  <SourceControlProvider runtimeMode={data.mode}>
    <ReportRoot {data} />
  </SourceControlProvider>
</WebQueryProvider>
