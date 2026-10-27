# ADR 0084: Retire accepted Memory, Checkout resolution and replication; the engine opens one store

- **Status**: Accepted
- **Date**: 2026-10-27
- **Executes**: phase B of [ADR 0074](0074-local-only-single-operator-product.md)
- **Retires**: [ADR 0024](0024-separate-usage-memory-and-shared-data-authorities.md),
  [ADR 0026](0026-db-native-agent-memory-with-file-adapters.md),
  [ADR 0028](0028-stable-project-identity-and-repository-locators.md),
  [ADR 0029](0029-application-owned-authorizer.md),
  [ADR 0038](0038-local-memory-store-writer-lease-and-startup-coupling.md) and
  [ADR 0044](0044-local-checkout-observation.md)
- **Amends**: [ADR 0027](0027-mcp-is-an-edge-adapter.md) (tool set),
  [ADR 0042](0042-local-session-distillation.md),
  [ADR 0043](0043-memory-library-and-explicit-local-promotion.md) and
  [ADR 0049](0049-retire-session-distillation.md) (what they preserved),
  [ADR 0075](0075-local-store-schema-evolution.md) (rule 4 applied twice)
- **Preserves**: [ADR 0009](0009-sole-writer-usage-engine-and-direct-sqlite-readers.md),
  [ADR 0058](0058-harness-sessions-read-work-context-through-one-bounded-projection.md)
  (`work.context`), [ADR 0077](0077-delegation-independent-of-the-calling-harness.md)
  (delegation tools)

## Context

ADR 0074 decided on 2026-10-24 to delete accepted Memory, the `/projects`
Checkout resolution review and replication once PR #67 had landed. It landed on
2026-10-25. By then:

- Nothing produced Memory content. ADR 0049 removed the only producer
  (promotion from a Session analysis); `recordObservation`, `createProposal`
  and Memory import had no route, so `/memory` could only review rows that
  already existed, and a fresh store stayed empty.
- `/projects` was a review queue that ADR 0044's automatic binding kept empty.
  Its name was mistaken for the Analysis project groups, which group report
  Sessions through `packages/report-data/src/project-projection.ts` and never
  read the Memory store.
- Replication had no receiver since phase A removed the server; it started
  only when `AI_USAGE_PLATFORM_BASE_URL` was set, and nothing could be set
  there.
- Every engine start still opened `memory.sqlite` read-write behind a second
  writer lease, served a second authenticated loopback listener, and failed
  closed when that store could not open (ADR 0038). The left rail had grown
  from 6 to 11 destinations in seven weeks, two of them these empty pages.

## Decision

1. **Accepted Memory and Checkout resolution are removed.** The packages
   `memory-service`, `memory-sqlite`, `memory-search`, `project-registry`,
   `authorization`, `authorization-contract` and `platform-core` are deleted,
   together with the engine's Memory service, writer lease and
   `memory-service.json` rendezvous, the Checkout observation runtime of
   ADR 0044, the Web `/memory` and `/projects` destinations and their
   procedures, CLI `memory search`, and the MCP tools `memory.search`,
   `memory.get` and `memory.project_context`. The residual Session-distillation
   storage that ADR 0049 left as a separate lot (portable account contracts,
   Memory account internals, SQLite account persistence,
   `local-machine/distillation-evidence`) goes with them. The rail has nine
   destinations.
2. **Replication is removed end to end.** `replication-client`,
   `replication-outbox`, `replication-protocol` and `identity` are deleted, with
   the engine replication runtime, the usage store's outbox writer, the
   `replication-status` control command, CLI `replication status`, the Sources
   replication panel and the `replication.status` procedure. Removing a command
   changes the control contract, so the engine control protocol moves from 3 to
   4; 3 is not reused.
3. **The engine opens one store.** It no longer opens, migrates, locks or
   deletes `memory.sqlite`. The file, its WAL siblings and any lock or
   rendezvous an older engine left beside it stay as they are (ADR 0075 rule 4):
   no code reads them, and reading their content again means running a
   revision from before this record against a copy. The usage store's writer
   lease, control plane and read path are unchanged (ADR 0009).
4. **Usage schema 5 drops the outbox.** The engine's forward-only migration
   drops `replication_outbox_state`, `replication_outbox_events` and their two
   indexes inside the migration transaction, whatever they contain: their rows
   were events for a server that no longer exists and no reader remains. A
   store at 3 goes to 5 without creating them, and a fresh store never has them.
   This is the operator's explicit exception to ADR 0075 rule 4, taken in
   ADR 0074 and confirmed on 2026-10-27. The upgrade note is in
   [`docs/local-store-upgrade.md`](../local-store-upgrade.md).
5. **MCP keeps its edge role with fewer tools.** The local stdio server serves
   `work.context` and the delegation tools and needs no Memory service. Its
   registered server name stays `ai-usage-memory`, the identity already
   written into operator configurations; renaming it would leave the old entry
   behind and register a duplicate.

Report Session grouping, project aliases, Analysis project groups,
`/skills/projects`, the Work view's own checkout status enumeration
(ADR 0051) and manual transfer (`/sync`, `snapshot`, `merge`, `machine`,
`cursor import`) are unaffected.

### Status of the records this touches

- ADRs 0024, 0026, 0028, 0029, 0038 and 0044 are **Retired**: the store,
  identities, authorizer, lease and Checkout binding they govern no longer
  exist in code. Their files keep their text as history.
- ADR 0027 keeps its edge rule; its Memory tools are gone.
- ADRs 0042, 0043 and 0049 preserved Memory and its publication restrictions;
  with Memory gone there is nothing left to publish or restrict, and their
  stored rows stay in the untouched file.
- ADR 0075's rules stand; rule 4 is applied to the Memory store (no longer
  opened, file kept) and, by the explicit exception above, to the outbox.

## Consequences

- One local authority: the usage store. Engine startup has one lease, one
  listener and one migration, and loses ADR 0038's fail-closed coupling.
- A usage store opened by this code cannot be opened by an older binary, and
  readers from this revision refuse a store the engine has not yet migrated, so
  the supervised stack upgrades together after the backup pair is taken.
- A Memory, Project-identity or authorization feature in the future starts
  from a new ADR; restoring the deleted packages from history is not such a
  plan.
- Operator configurations that list the MCP server keep working; its three
  Memory tools disappear from the tool list.

## Rejected alternative

Keeping the Memory store and its service dormant until a producer exists was
rejected. Nothing had produced Memory since ADR 0049, and the dormant feature
still cost a second lease, a second listener, a startup failure mode, two rail
destinations and every package upgrade of ten workspace packages. Keeping the
outbox tables inert at usage schema 4 was rejected by the operator: they would
stay in every new store as schema for a feature that no longer exists.

## Evidence

- [Engine composition](../../apps/usage-engine/src/main.ts)
- [Usage store migration](../../packages/usage-store/src/index.ts) and its
  [tests](../../packages/usage-store/src/migration.test.ts)
- [Engine control contract](../../packages/usage-engine-control/src/contracts.ts)
  (`USAGE_ENGINE_PROTOCOL_VERSION`)
- [Rail destinations](../../apps/web/src/lib/features/shell/navigation.ts)
- [MCP server](../../apps/mcp/src/main.ts) and
  [registration](../../packages/mcp-adapter/src/registration.ts)
- [Report project projection](../../packages/report-data/src/project-projection.ts)
- [Local store upgrade procedure](../local-store-upgrade.md)
- Plan 120 (`plans/120-local-only-cleanup.md`, operator decisions 1, 5 and 6)
