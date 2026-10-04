# ADR 0041: Resolve detail identity independently from exploration depth

- **Status**: Accepted
- **Date**: 2026-10-04
- **Amends**: 0039, the selected-identity recovery and reload clauses

## Context

The URL-addressed Rounds panel and continuous campaign exploration were developed
on parallel branches. Restoring a selected session by replaying member pages
would make a valid deep link depend on the scroll recovery budget. Loading
Members through the Sessions destination would also leave Overview and direct
links without the same detail capabilities.

## Decision

Resolve a session from already acquired rows at the inspected revision first.
Otherwise use one indexed `session.lookup` request for that revision and opaque
row identity. Campaigns additionally validate the row's canonical campaign.
An absent row, expired revision and failed request remain distinct visible
states. Superseded results cannot select another row or acquire a new revision.

Direct report and Campaigns links prefetch an unresolved bounded metadata lookup during SSR using
the same immutable Query identity hydrated by the browser. Native detail and
prompt content remain outside SSR. The existing one-item campaign projection
resolves a campaign route whose aggregate is outside the acquired window.

Selection does not consume scroll recovery pages. Actual viewport anchors still
use ADR 0039's bounded reconstruction, including its explicit failure state.
Full reload restores the selected identity without promising arbitrary scroll
depth. Store-wide search and its filtered result restoration stay separate.
If the detail interface fails to load, offer an explicit reload of that URL;
browsers may retain a failed module import for the lifetime of the document.
Never reload automatically or replay an action.

The shell owns navigation intent through a per-shell context. Report detail
paths and Campaigns search parameters retain their existing URL forms and
mounted exploration owners. Opening a detail pushes one marked history entry;
browsing within it replaces that entry; closing an owned entry travels Back.
Direct-load close returns to the corresponding exploration destination. Focus
returns after rendering to a connected control or stable viewport without
moving the anchor. The detail owner remains outside virtual rows.

An open report detail pins its revision even over Overview or Breakdown and
across filter changes. Deep Sessions exploration retains its existing pin.
A publication received during inspection remains pending after closing the
detail, until the explicit new-data action. Expiration never silently
substitutes the current revision.

The lazy detail owner acquires campaign members with the same immutable
100-member, date-ascending Query identity as Agent Map. Members shows the full
campaign scope while report filters remain applied to the background. A partial
filtered page cannot prove that an unlisted member is hidden. Continuous
acquisition and measured virtualization bound requests and rendered rows;
Rounds joins only available member evidence and never invents launch attribution.

## Consequences

Detail selection, page acquisition and viewport restoration have distinct
responsibilities while Query remains the sole server-state owner. A distant
selection does not require downloading the preceding campaign history. Loading
the detail owner on demand keeps its member UI outside the initial report
closure.

## Rejected alternative

Increasing the reconstruction budget to find every selected session, or loading
all members when opening the panel, would turn detail navigation into an
unbounded history scan.

## Evidence

- [Detail resolution](../../apps/web/src/lib/features/sessions/detail/detail-selection.ts)
- [Campaign detail resolution](../../apps/web/src/lib/features/campaigns/campaign-detail-selection.ts)
- [Detail member owner](../../apps/web/src/lib/features/sessions/detail/session-detail-members-query-slot.svelte)
- [Combined production workflows](../../apps/web/e2e/session-detail-integration.scale.ts)
- [SSR acquisition](../../apps/web/src/lib/features/report/core/report-bootstrap.ts)
