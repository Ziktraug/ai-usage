# P3 integration request

P3 owns the Sessions table implementation only. X0 must compose it without
moving query, revision, paging, expansion, or responsive state into route files.

## X0 report composition

In the report destination selected by `apps/web/src/lib/features/report/core/report-root.svelte`:

1. Resolve the browser `SessionClientAdapter` from the request-scoped oRPC
   client and use the existing request/navigation-scoped `QueryClient`.
2. In `live-report-destination.svelte`, create exactly one
   `SessionTableQueryOwner` and inject it into `createFocusedReportSession` as
   `sessionOwner`. The focused session must prepare and commit the timeline-only
   Overview projection and the first Sessions page at the same served revision.
   Do not create a second `ServedReportSession` or bootstrap owner.
3. Mount exactly one `ReportLifecycleOwner` for that combined focused session.
   Both `FocusedDestinationRefresh` and `SessionDestinationRefresh` receive its
   snippet owner. The latter binds paging expiry recovery to
   `owner.refresh({ ...activeDestination, sessions: scope })`, preserving P1
   retry, supersession, replay, and atomic visible commit semantics.
4. Render `session-table.svelte` from the shared query owner rows and snapshot
   in `sessions-destination.svelte`. Wire `onLoadMoreRows` to
   `queryOwner.loadMore()` and `onLoadCampaignChildren` to
   `queryOwner.loadCampaignChildren(campaignKey)`. Pass the canonical query
   string from `queryState` as `searchQuery` so the session title projection
   highlights it. Keep sorting/visibility URL state in the existing R0 dashboard
   adapter. Incremental expiry recovery is already wired through the combined
   focused lifecycle: consumers must not add a second retry, query owner, or
   acquisition path.
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
