# ADR 0078: Work association evidence and source activity

- **Status**: Accepted
- **Date**: 2026-10-26
- **Amends**: 0063
- **Amended by**: [0079](0079-ticket-routing-and-jira-intake.md) (an authored PR's branch key may route it to its ticket's task), [0082](0082-work-priorities-reports-team-reviews-handed-off-tickets.md) (reports are not requests)

## Context

Desktop lists PRs observed in a shared checkout alongside a session's own PR.
Treating every entry as continuity linked unrelated conversations to one task.
Collection timestamps also displaced the chronology of the actual work.

## Decision

Desktop PR membership requires `own: true`. Observed-only references still feed
fact collection, but do not attach sessions. Native session PR declarations and
operator associations retain their existing semantics. Existing accidental links
are detached through engine commands after evidence review, never deleted or
silently migrated. Detachment remains a veto against automatic reattachment.

Work defaults to global latest source activity before pagination; collection and
automatic link timestamps are excluded. Optional project grouping and oldest-first
history remain available. PR, CI, review, Jira and local disk state are displayed
separately with direct artifact links and observation provenance. Exact Jira key
segments in a PR head branch may provide contextual ticket facts without merging
threads. Unknown URLs and disk states remain unknown.

A Desktop report naming another PR is retained in its session, but is not promoted
to a task-level native request. Collapsed session rows omit full reports; delegates
remain nested under their parent and source links remain detachable.

## Consequences

Shared checkout identity is not task identity. We reject guessing associations
from titles, working directories or arbitrary mentions. A session can still start
a work thread through session intake without a ticket or PR. Personal follow-up
state is unchanged by PR merges, ticket closure or disappearing worktrees.

## Evidence

- [Source adapter regressions](../../packages/usage-engine-runtime/src/source-adapters.test.ts)
- [Activity pagination](../../packages/usage-store/src/work-thread-store.test.ts)
- [Artifact projection](../../packages/report-data/src/work-thread-read.test.ts)
- [Browser journeys](../../apps/web/e2e/work-threads.spec.ts)
- [Store upgrade procedure](../local-store-upgrade.md)
