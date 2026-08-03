# P3 integration request

P3 owns the Sessions table implementation only. X0 must compose it without
moving query, revision, paging, expansion, or responsive state into route files.

## X0 report composition

In the report destination selected by `apps/web/src/lib/features/report/core/report-root.svelte`:

1. Resolve the browser `SessionClientAdapter` from the request-scoped oRPC
   client and use the existing request/navigation-scoped `QueryClient`.
2. Mount exactly one `session-table-owner.svelte`. Its injected `acquire`
   function must resolve the current served descriptor from the already-owned
   report bootstrap/current alias; it must not create a second bootstrap owner.
3. From the owner's snippet, call
   `owned.lifecycle.refresh({ scope })` when the canonical Sessions query scope
   changes. This is the only client-created `ServedReportSession` destination
   path and preserves P1's expiry retry, supersession, and atomic commit.
4. Render `session-table.svelte` from `owned.rows` and `owned.snapshot`. Wire
   `onLoadMoreRows` to `owned.query.loadMore()` and
   `onLoadCampaignChildren` to `owned.query.loadCampaignChildren(campaignKey)`.
   Pass `owned.snapshot?.query.filters.query ?? ''` as `searchQuery` so the
   session title projection highlights the canonical query. Keep
   sorting/visibility URL state in the existing R0 dashboard adapter. Incremental
   expiry recovery is already wired through the owner's sole P1 lifecycle:
   consumers must not add a second retry or acquisition path.
5. Do not wrap desktop/mobile variants in separate owners. The component owns
   one expansion/focus/virtual state and switches its one active projection at
   the `session-surface-mode.ts` boundary.

The composition must remain downstream of demo/synthetic selection. No live
client, descriptor acquisition, or session request may be created for demo or
E2E payload modes.

## P4 detail integration

P4 receives the selected `SessionPresentationRow.rowId` from `onSelect` and
returns that stable identity through its URL/history adapter. It may use V2/Q1
neighbors/detail/VCS operations, but it must not create a second page/campaign
operation owner or move selection into the virtual rows. Pass `selectedRowId`
back to `session-table.svelte` so desktop and mobile projections retain the same
selection across viewport changes.

X0/P4 should preserve the P3 evidence selectors:
`data-session-table-owner`, `data-session-surface`, `data-session-row-id`,
`data-session-index`, `data-virtual-spacer`, and
`data-session-paging-sentinel="mobile"`.
