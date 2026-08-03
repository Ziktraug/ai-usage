# P1 report root integration request

P1 does not edit the coordinator-owned SvelteKit route leaves. At X0, replace
the R1 report marker with the following exact composition.

## Await and dehydrate the report bootstrap

Add `apps/web/svelte-shadow/routes/+page.ts`:

```ts
import { error } from '@sveltejs/kit';
import { loadReportPageData, ReportBootstrapUnavailableError } from '$lib/features/report/core/report-bootstrap';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent, url }) => {
  const parentData = await parent();
  try {
    return await loadReportPageData({
      fetch: (request) => fetch(request),
      mode: parentData.runtimeMode,
      requestOwner: 'report-root-ssr',
      url,
    });
  } catch (cause) {
    if (cause instanceof ReportBootstrapUnavailableError) {
      error(cause.status, cause.message);
    }
    throw cause;
  }
};
```

`loadReportPageData` chooses demo/E2E data before constructing a real report
client. In live mode it awaits the current-alias bootstrap, accepts the server's
compatible stored publication, turns typed unavailability into the bounded 503
route error above, and returns the dehydrated exact query key.

## Render the hydrated root

Replace `apps/web/svelte-shadow/routes/+page.svelte` with:

```svelte
<script lang="ts">
  import ReportRoot from '$lib/features/report/core/report-root.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<ReportRoot {data} />
```

Do not add another query provider. The accepted R1 root provider reads
`page.data.queryState`, so the exact current-alias data returned above is
available to `ReportRoot` during SSR and hydration without a second bootstrap.

## Own focused destination cleanup

Each P2/P3 client-created `ServedReportSession` must be consumed through
`report-lifecycle-owner.svelte`; never serialize a session through page data or
reimplement expiry/supersession in the route:

```svelte
<ReportLifecycleOwner {session}>
  {#snippet children(owner)}
    <ReportDestination snapshot={owner.snapshot} onRefresh={owner.refresh} />
  {/snippet}
</ReportLifecycleOwner>
```

The consumer calls `owner.dispose()` from `onDestroy`, which aborts pending
work exactly once. Root composition must keep the last complete workspace
visible while a focused destination refresh is pending or fails.
