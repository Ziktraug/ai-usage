# ADR 0049: Retire Session distillation while preserving Memory and stored evidence

- **Status**: Accepted
- **Date**: 2026-10-21
- **Supersedes in part**: ADR 0042 and ADR 0043, as specified below
- **Preserves**: ADR 0009, ADR 0010, ADR 0012, ADR 0038 and ADR 0044

## Context

The current generated Session-account feature is withdrawn. Native harness
memory remains part of the workflow; the product does not replace it with a
library of summaries to administer. Existing Memory and identity services share
storage contracts with the withdrawn feature, so removing its user surface
must preserve historical evidence and publication restrictions.

## Decision

Depublish the `analyses` CLI, repository session-distillation skill and its
projections, Session drawer distillation tab, generated-account Memory library,
discovery and promotion flows, dedicated Query/client/server/router contracts,
promotion publication endpoints, engine generation runtime and dedicated
fixtures/spike tools. Former routes are unavailable. Existing account provenance
is text or structured evidence without links to removed pages.

This supersedes ADR 0042's active generated corpus, harness generation protocol,
job execution lifecycle, Session-panel account access and CLI recall decisions.
It supersedes ADR 0043's analyzed-Session library, account discovery, progressive
processing, historical account navigation and creation of proposals by promoting
an account passage. Pending proposal review, accepted Memory, exact accepted
revisions, accepted-Memory search and MCP retain their meanings.

The data-preservation and authority boundaries in those ADRs remain: generated
accounts do not become accepted guidance, existing evidence is retained, and
previously promoted knowledge keeps its local-only publication policy across
acceptance, edits and replication backfill. No migration, table or existing data
is deleted and the schema version is unchanged. Residual storage/domain modules
are listed in the [retirement notice](../session-distillation.md); removing them
is a separate lot with its own dependency and compatibility review.

Native harness memory, collectors/readers, native Session detail/analysis,
rounds/timeline, machine-qualified identities, Project/Repository bindings and
Memory authentication remain. ADR 0044's Checkout observation and mapping
behavior remains in force independently of the retired discovery feature.
Future automatic interpretation remains possible without restoring a summary
library by default.

## Consequences

There is one coherent supported Memory surface for accepted knowledge and
proposal review. Retained account records are no longer reachable through the
withdrawn product routes, but opening a compatible store does not purge them.
Retirement regressions cover rejected routes, retained authenticated Memory
operations, provenance rendering and disposable-store preservation. Real-store
upgrade safety still follows the existing backup procedure and needs separate
operator verification.

## Rejected alternative

Deleting account tables and promotion relations during depublication would
remove existing evidence and could erase the publication exclusions attached
to accepted knowledge. Keeping a replacement summary library would preserve
the workflow that the product has withdrawn.

## Evidence

- [Retirement notice and residual lot](../session-distillation.md)
- [Browser route rejection tests](../../apps/web/src/lib/server/rpc/handler.server.test.ts)
- [Authenticated Memory service tests](../../apps/usage-engine/src/memory-service-server.test.ts)
- [Historical provenance projection](../../packages/memory-service/src/browse.test.ts)
- [Promotion persistence and publication regressions](../../packages/memory-sqlite/src/analysis-promotion.test.ts)
- [Local store upgrade procedure](../local-store-upgrade.md)
