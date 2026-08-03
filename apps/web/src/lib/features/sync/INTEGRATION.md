# Canonical Sync integration

`apps/web/src/routes/sync/+page.server.ts` awaits `loadSyncPageData` with the
route `fetch`, current URL, and stable `sync-root-ssr` request owner. The page
component renders one `SyncRoot`, consumes the existing source-control context,
and relies on the root `WebQueryProvider` to hydrate the returned query state.
It does not acquire fleet data or create another query client.

`apps/web/src/hooks.server.ts` owns the singleton
`webReadObservabilityLifecycle`. Module initialization starts it once, the
SvelteKit `handle` awaits initialization before resolving requests, and the
single `sveltekit:shutdown` callback awaits disposal before exit. No feature
route creates another observability runtime, Effect scope, sink, shutdown
listener, or timer.

Manual transfer remains file-only through these explicit route leaves:

- `apps/web/src/routes/api/manual-merge/download/+server.ts` exports `POST` and
  delegates to `handleManualMergeDownloadEndpoint`.
- `apps/web/src/routes/api/manual-merge/upload/+server.ts` exports `POST` and
  delegates to `handleManualMergeUploadEndpoint`.

Both leaves pass the original request and authoritative per-request runtime mode
to the policy-enforcing server adapter. They do not acquire deep handlers,
processes, database paths, or configured maintainer state themselves.
