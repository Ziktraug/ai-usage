# Canonical Sessions table integration

`live-report-destination.svelte` reads the complete Session window from the
composite report-destination Query. Session pages and cursors remain in exact
revision/fingerprint Query entries; no table owner mirrors them in `$state`.

## Query and component ownership

1. The outer destination Query publishes Overview plus the complete requested
   Session window atomically at one descriptor revision.
2. `session-window.ts` owns top-level, campaign-child, and unfiltered campaign
   page families. Increasing depth fetches only the missing cursor page; a new
   revision replays requested depth before it becomes visible.
3. Components keep only requested depth, expanded campaign IDs, sort/visibility,
   focus, selection, and virtualization intent.
4. `sessions-destination.svelte` and `session-table.svelte` project Query data
   directly. Loading and error affordances come from Query observers.
5. Desktop and mobile variants share one expansion/focus/virtual state and one
   active surface at the `session-surface-mode.ts` boundary.

The composition remains downstream of demo/synthetic selection. Demo and E2E
payload modes create no live client, descriptor acquisition, or Session request.

## Surface sizing

On desktop, the Sessions surface is the only scroll container: the document is
one viewport high and the surface height is the viewport minus its document top,
dynamic in-owner trailing controls, and static space below its owner. On mobile,
the page anchors at the Session region start; the surface uses the remaining
space after subtracting the same dynamic controls and all static space below
the owner, including page padding and the fixed-navigation reserve.
Only the three-row desktop and one-card mobile minimum heights let
the page scroll past the surface. `session-row-window.ts` is the pure sizing
model; `session-viewport-geometry.spec.ts` pins the browser contract.

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
