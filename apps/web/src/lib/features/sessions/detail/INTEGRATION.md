# P4 Session detail integration request

P4 owns the Session selection, neighbor/detail/VCS query owner, controlled
Drawer, chronology, and VCS presentation. X0 composes these modules without
moving selection into P3 virtual rows or creating another report lifecycle.

## Sole report composition

1. Create one SessionDetailQueryOwner from the existing request/navigation
   QueryClient and the same browser SessionClientAdapter already used by P3.
   Create one SessionDetailController beside the sole P3 table owner and
   dispose both with the report destination.
2. Mount one session-detail-slot.svelte outside the desktop/mobile virtual
   projections. Pass P3's flattened visible rows and a nullable
   SessionSelectionInput.
3. For a served P3 selection, pass the exact current
   SessionTableQueryState.query, sessionCount, selected
   SessionPresentationRow, and its existing P3/page-item-derived
   SessionAnalysisTarget. For an Overview/local selection pass the row and
   P1's accepted revision when one exists; never acquire a report or page from
   the detail packet.
4. Feed onSelectedRowId from the controller back to P3's selectedRowId. Keep
   onSelect row identity as row.rowId; do not put selection, neighbor,
   analysis, or VCS state in either virtual projection.
5. Wire project/model filter actions to the existing R0 dashboard search
   adapter with preserved focus and scroll. Closing the Drawer clears only
   selection. R0's structured Drawer identity deliberately adds no new query
   parameter, so unrelated URL history/back-forward entries retain their
   canonical dashboard meaning.
6. Render P8's accepted campaign-label editor and campaign-session controls
   through `campaignSlot`. The slot sits in the legacy location between the
   comparison summary and detail grid; P4 deliberately does not duplicate P8
   mutation ownership or show a global "Clear filters" action.

The owner consumes Q1's exact immutable neighbor/detail/VCS keys unchanged.
Selection replacement cancels stale operations, and local rows never issue
neighbor/detail/VCS calls without an accepted revision.

## X0 process-token evidence

Run the existing dashboard Drawer navigation/focus/Escape/history cases and
production chronology/VCS cases with synthetic report and local-history
fixtures. Assert focus returns to the invoking Overview/table control, editable
targets ignore j/k/arrow shortcuts, one exact neighbor request owns navigation,
and a superseded detail/VCS request is aborted without late UI publication.
