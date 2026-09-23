# Canonical Session detail integration

`session-detail-query-slot.svelte` owns the dependent Query observers for
neighbors, detail, and VCS. Selection and Drawer focus remain local interaction
state; remote values and their pending/error states are never copied into a
controller snapshot.

## Sole report composition

1. Mount one `session-detail-query-slot.svelte` outside the desktop/mobile
   virtual projections and pass a nullable `SessionSelectionInput`.
2. A served selection carries the exact current query, selected row, count, and
   page-item-derived analysis target. An Overview selection carries the row and
   accepted revision without fabricating a served page query.
3. Create neighbors, detail, and VCS observers from the same persistent Query
   client and `SessionClientAdapter` used by the report destination.
4. Query keys include immutable revision and canonical row/query identity.
   Replacing selection supersedes stale work without late publication.
5. Local rows issue no neighbor/detail/VCS call without an accepted revision.
6. Feed selected row identity back to the table without putting selection or
   remote data in either virtual projection.
7. Wire project/model filters, closing, history, and focus restoration to the
   existing dashboard interaction adapters.

Campaign controls arrive as two snippets: `campaignLabelSlot` (the label editor)
renders under the identity block, and `campaignSlot` (the member list) renders
in the Members tab, which the drawer shows only for campaigns of more than one
session. `memberRows` carries the campaign's loaded member rows so the rounds
reader joins child links to the canonical report rows (ADR 0018) instead of
re-pricing them, and `onSelectMember` lets it open a member through the
destination's own route change. The local detail loads as soon as a row is
selected: Rounds is the panel's first view, and the Timeline and Summary tabs
read the same response.

## X0 process-token evidence

Run the existing dashboard Drawer navigation/focus/Escape/history cases and
production chronology/VCS cases with synthetic report and local-history
fixtures. Assert focus returns to the invoking Overview/table control, editable
targets ignore j/k/arrow shortcuts, one exact neighbor request owns navigation,
and a superseded detail/VCS request is aborted without late UI publication.
