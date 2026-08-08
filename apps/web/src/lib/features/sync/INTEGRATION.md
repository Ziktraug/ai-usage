# Canonical Sync integration

For a document request, `apps/web/src/routes/sync/+page.server.ts` awaits the
bounded fleet under its compatible-generation Query key and dehydrates it with
the stable `sync-root-ssr` owner. For SPA entry it returns an empty hydration
delta, so the persistent browser observer serves a fresh fleet or performs a
background finite refresh. The page renders one `SyncRoot`, consumes the shared
source-control context, and never creates another client or fleet result owner.

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
