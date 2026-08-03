# P7 Sync integration request

Ownership of route leaves, the root query provider and `hooks.server.ts` remains
with the coordinator. Integrate this packet exactly once as follows.

1. Create `svelte-shadow/routes/sync/+page.server.ts`. Its awaited
   `PageServerLoad` must return
   `loadSyncPageData({ fetch, requestOwner: 'sync-root-ssr', url })`; the stable
   request owner lets the SvelteKit hook restore same-origin evidence only for
   this framework-proven internal RPC subrequest. Do not start an unawaited
   query, create a second QueryClient, or fetch fleet data in the component.
2. Replace the marker-only `svelte-shadow/routes/sync/+page.svelte` with one
   `SyncRoot` from `$lib/features/sync/sync-root.svelte`. Read the existing P6
   context with `useSourceControl()` from
   `$lib/features/sources/context.svelte`, derive `connection` from
   `sourceControl.state().connection`, and render exactly
   `<SyncRoot {connection} {data} />`. The root layout's existing
   `WebQueryProvider` hydrates `data.queryState`; do not add another provider.
   `SyncRoot` owns its `main` landmark and heading, so do not retain
   `RouteFrame`.
3. In `svelte-shadow/hooks.server.ts`, import the singleton
   `webReadObservabilityLifecycle` from
   `$lib/server/observability/web-read-lifecycle.server`. At module startup,
   retain one `const observabilityInitialization =
   webReadObservabilityLifecycle.initialize()`. At the beginning of the single
   `handle`, `await observabilityInitialization` before `resolve(event)` can
   acquire report data.
4. Replace the existing shutdown callback with exactly one async owner:

   ```ts
   process.once('sveltekit:shutdown', async () => {
     await webReadObservabilityLifecycle.dispose();
     process.exit(0);
   });
   ```

   The awaited disposal must finish before process exit. Do not create a second
   observability runtime, Effect scope, sink, shutdown listener or timer.
5. Create the two currently missing manual-merge SvelteKit leaves; do not wait
   for or retain a placeholder route:

   - `svelte-shadow/routes/api/manual-merge/download/+server.ts` exports `GET`.
     Import the P7 `handleManualMergeDownloadEndpoint` adapter from
     `$lib/features/sync/server/manual-merge-endpoints.server` and return
     `handleManualMergeDownloadEndpoint(request, locals.runtimeMode ?? 'live')`.
   - `svelte-shadow/routes/api/manual-merge/upload/+server.ts` exports `POST`.
     Import the P7 `handleManualMergeUploadEndpoint` adapter from the same
     module and return
     `handleManualMergeUploadEndpoint(request, locals.runtimeMode ?? 'live')`.

   Each `RequestHandler` must pass the original `request` and the authoritative
   per-request runtime mode exactly as shown. The P7 adapters enforce policy
   before either dynamic deep-handler import; the route leaves must not acquire
   or import those deep handlers themselves.

The feature owns no process acquisition outside the coordinator hook, no
database path, and no access to configured maintainer state.
