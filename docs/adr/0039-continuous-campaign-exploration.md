# ADR 0039: Preserve context during continuous campaign exploration

- **Status**: Accepted; selected-identity recovery and reload clauses amended by 0041
- **Date**: 2026-10-04
- **Amends**: 0004 and 0012

## Context

Campaign discovery, Agent Map and Project Timeline used explicit page buttons
and mounted every loaded row. A publication could replace several inspected
pages with the first page of a new revision. Appending older campaigns also
changed the timeline scale.

## Decision

Acquisition remains exact-revision cursor paging (40 campaigns, 100 members).
The visible virtual window requests the next page before its trailing edge.
Only visible surfaces acquire; automatic advancement without a scroll or resize
has a small budget. Short pages receive a separate viewport-sized fill budget;
continuations that do not grow the visible projection cannot renew it. Errors
retain the readable prefix and require local retry.
Repeated cursors, repeated identities and empty continuing pages are errors.

One Query composite publishes the requested campaign and member depths together.
Query retains the immutable pages; components retain only navigation intent.
Obsolete inactive composites are removed after success, while the existing
ten-minute exact-page cache preserves previous exploration. DOM virtualization
does not imply constant data memory: acquired pages remain available for upward
scrolling until normal Query collection.

Campaigns pin their served revision and expose an explicit new-data action.
Refresh replays depth with new cursors and seeks the visible and selected stable
identities. Recovery is limited to four additional pages per family and 32 new
page acquisitions per reconstruction. A limit or expired revision leaves the old
view readable, with explicit retry or return to current results. Sessions also
pin during deep exploration or an open detail; initial shallow views may update.

Variable-height rows are measured in one scroll surface per active collection.
A logical row identity and viewport offset survive append, reordering and view
switches. The drawer lives above virtual rows. SvelteKit snapshots retain local
navigation on Back/Forward; the URL carries filters, campaign and session
selection. Full reload restores the selection within the bounded recovery
window, not arbitrary scroll depth.

Finite timeline axes use the selected time bounds. Presets cover the selected
calendar period at the displayed revision's reference date, independently of the
query's filtering bounds. The presentation domain travels with the Query
composite so retained data keeps its own axis during replacement. All-history
and open custom axes retain their
initial extent until an explicit fit action. Campaign acquisition order determines
projection order. Newly acquired campaigns append as project continuations, so a
downward traversal also encounters additions to earlier projects. Expansions and
revision changes use logical anchoring.
Activity filters retain their existing meaning and do not become interval
intersection queries. Partial project timing stays partial after aggregation;
isolated timestamps remain points.

## Consequences

Mouse, trackpad and keyboard navigation no longer require a page control.
Search continues to run over the store, with filtered member discovery separate
from full hierarchy inspection. Refresh restores a selected search result through
the filtered query without replaying the preceding full hierarchy. Large
reordering beyond the recovery budget is
visible as a recovery choice, rather than a silent jump to the first page.

## Rejected alternative

Downloading the entire report or evicting early pages to enforce a constant
client heap would break bounded acquisition or natural upward navigation.

## Evidence

- [Campaign Query composition](../../apps/web/src/lib/query/options/campaigns.ts)
- [Virtual collection](../../apps/web/src/lib/features/campaigns/campaign-virtual-list.svelte)
- [Continuity regressions](../../apps/web/e2e/campaign-continuity.scale.ts)
- [Query regressions](../../apps/web/src/lib/features/campaigns/campaigns-continuity.test.ts)
