# Session distillation retirement

Session distillation is retired by [ADR 0049](adr/0049-retire-session-distillation.md).
The generated Session-account library, its promotion flow, the `analyses` CLI,
repository skill, Session drawer tab, dedicated browser/API contracts and engine
runtime are withdrawn. There is no replacement library of summaries to manage.
Future automatic interpretation remains possible under a separate product and
architecture decision.

Native harness memory, collected history, Session detail and native analysis,
rounds and timeline remain. Memory continues to expose accepted knowledge,
proposal review and its accepted-Memory/MCP APIs through the authenticated
Memory service. Project, Repository, Checkout and machine-qualified identities
remain; [Checkout observation (ADR 0044)](adr/0044-local-checkout-observation.md)
continues independently. Knowledge can still be filtered by an explicit Project
ID without invoking the retired discovery catalogue.

## Existing data and historical provenance

This is depublication, not a storage purge. No table, migration, schema version
or existing record is removed. Existing jobs, accounts, evidence and promotion
relations remain in the Memory store, although the retired account pages and
commands no longer expose them. Pending proposals and accepted knowledge remain
usable, including exact accepted revisions. Their historical account provenance
is shown as text or structured evidence, never as a link to a removed account
page.

Existing local-only publication restrictions remain enforced for previously
promoted knowledge. Acceptance, editing, sensitivity changes and replication
backfill cannot grant publication permission. Native session readers and
collectors remain available; retirement does not authorize reading or migrating
an operator store. Follow [the local store upgrade procedure](local-store-upgrade.md)
for any future code-version change against real stores. Disposable-store tests
do not prove a real-store upgrade.

## Residual deletion lot

The following implementation remains internal and is not a published generation
or account-browsing feature. Removing it requires a separate dependency and
compatibility review; exported modules alone do not authorize deleting durable
data or its protections.

| Area | Remaining files and responsibility |
| --- | --- |
| Native evidence extraction | `packages/local-machine/src/distillation-evidence.ts`, `packages/local-machine/src/distillation-evidence.test.ts`, and the export in `packages/local-machine/package.json`. |
| Portable account contracts | `packages/platform-core/src/session-distillation.ts`, `packages/platform-core/src/session-distillation.test.ts`, `packages/platform-core/src/distillation-evidence.ts`, `packages/platform-core/src/distillation-discovery.ts`, and their exports in `packages/platform-core/package.json`. |
| Memory account internals | `packages/memory-service/src/analysis-promotion.ts`, `packages/memory-service/src/distillation-errors.ts`, `packages/memory-service/src/distillation-redaction.ts`, `packages/memory-service/src/distillation-redaction.test.ts`, `packages/memory-service/src/distillation-repository.ts`, `packages/memory-service/src/embedded-json.ts`, `packages/memory-service/src/embedded-json.test.ts`, and the dedicated exports in `packages/memory-service/package.json`. |
| Shared Memory contracts | `packages/memory-service/src/browse.ts` still uses the portable account validators for accepted-knowledge parsing; `packages/memory-service/src/domain.ts` retains the historical provenance shape; `packages/memory-service/src/repository.ts` retains the local-analysis proposal source port. Their retained behavior must be disentangled before removing account contracts. |
| SQLite account persistence | `packages/memory-sqlite/src/distillation.ts`, `packages/memory-sqlite/src/distillation.test.ts`, `packages/memory-sqlite/src/distillation-catalog.ts`, `packages/memory-sqlite/src/distillation-catalog.test.ts`, `packages/memory-sqlite/src/distillation-progress.ts`, and the repository attachment in `packages/memory-sqlite/src/identity.ts`. |
| Unused report metadata reader | `queryDistillationSessionMetadata` in `packages/usage-store/src/index.ts` and its export in `packages/usage-store/src/reader.ts`. The dedicated runtime consumer is removed. |

These retained dependencies and safeguards are **not** a deletion target:

- `packages/memory-sqlite/src/schema.ts`, migration steps in
  `packages/memory-sqlite/src/identity.ts`, and
  `packages/memory-sqlite/src/migration.test.ts` preserve schema history and
  existing rows. `packages/memory-sqlite/src/memory.ts` preserves provenance,
  accepted-Memory reads and publication exclusions;
  `packages/memory-sqlite/src/analysis-promotion.test.ts` and
  `packages/memory-sqlite/src/application.test.ts` retain preservation and
  publication regression coverage.
- `apps/usage-engine/src/checkout-observation-runtime.test.ts` retains catalogue
  assertions that verify the preserved Project/Checkout mappings independently
  of the retired discovery runtime.
- `packages/memory-service/src/export.ts`,
  `packages/memory-service/src/migration.ts` and their migration tests retain
  the legacy `distillation_hash` import/export compatibility field.
  `packages/memory-service/README.md` is the dated legacy-format inventory.
- `apps/usage-engine/src/memory-service-server.test.ts` and
  `apps/web/src/lib/server/rpc/handler.server.test.ts` retain former route names
  as negative retirement guards proving those endpoints stay unavailable.
  Historical ADRs and execution plans retain their original descriptions and
  evidence references, including references to retired files.

## Historical decisions

[ADR 0042](adr/0042-local-session-distillation.md) records the original local
account corpus and bounded generation design.
[ADR 0043](adr/0043-memory-library-and-explicit-local-promotion.md) records the
library, progressive processing and explicit promotion design.
[ADR 0049](adr/0049-retire-session-distillation.md) names the superseded clauses
and preserved data obligations. Their bodies and
[plan 115](../plans/115-local-session-distillation.md) remain historical records.
