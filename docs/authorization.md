# Authorization model and operations

> **Implementation status:** Accepted target specification. The authorization
> packages, PostgreSQL model, benchmark, and verification evidence below are
> pending integration and are not available on `main`; plan 103 remains
> `IN PROGRESS` in `plans/README.md`.

This is the accepted reference for the local and connected authorization seam.
It describes the application-owned `Authorizer`, the PostgreSQL V1 relation
model, the Project-listing vertical, coarse row-level security, audit writes,
and the measured OpenFGA escape hatch prepared by plan 103 implementation work.

Authentication and credential issuance are separate plan-104 concerns. An
authenticated identity becomes a Person principal before it reaches this
model; authentication never grants a relationship by itself.

## Application boundary

`@ai-usage/authorization` owns one tri-state port:

- `check` returns allow, deny, or a typed operational error;
- `listResources` returns a bounded ordinary page with a principal-, Space-,
  permission-, and resource-kind-bound opaque cursor;
- `materializeResourceScope` returns a complete opaque authorization scope or
  a typed error. It never returns a partial scope or applies a pre-ranking cap.

Every request names a principal, permission, resource kind, active Space, and
trusted-Device condition. A missing or mismatched active Space fails closed.
The permission/resource map is explicit code, not a policy DSL. Decision and
error traces carry rule/operation identifiers only; they never include source
context, prompts, Memory, or Work handoff content.

Routes, MCP tools, serializers, UI filters, and jobs do not implement a second
ACL. They call an application service, which calls the `Authorizer` before a
content read or mutation. Browser and CLI production dependency closures are
guarded from the authorization implementation and PostgreSQL adapter.

## Adapters and conformance

Three adapters use the same contracts:

- `SingleUserAuthorizer` permits the bootstrapped Person only over compatible
  resources in the personal Space and requires no network or PostgreSQL;
- the in-memory organization adapter exercises the complete organization
  model and instruments relation reads for isolation assertions;
- the PostgreSQL adapter runs explicit, indexed domain queries under a
  transaction-local Space context.

The immutable conformance fixture covers local ownership, personal versus
organization isolation, explicit Project/session/content grants, admin without
content wildcard, aggregate-only and security-auditor roles, bounded Team
nesting and revocation, mixed personal/organization Device provenance,
sensitive Memory, SCM-installation separation, cursor safety, complete scope,
fail-closed adapter errors, and content-free aggregate evaluation. The same
organization scenarios run unchanged against the PostgreSQL adapter.

The accepted V1 organization role semantics are deliberately narrow:

- `admin` manages organization membership, Teams, and authorization; it is not
  an implicit Session, Memory, or Work handoff content reader;
- `usage-auditor` reads authorized organization/Project usage aggregates only;
- `security-auditor` reads Repository, Device, and Session metadata explicitly
  covered by its queries, never sensitive content by name alone;
- organization content requires an explicit Person or Team content grant;
- an SCM installation repository grant never becomes a Person permission.

Nested Team membership is the only recursive relation. The recursive CTE walks
the concrete child-Team to parent-Team relation, rejects cycles in-query, and
has a maximum effective depth of three. In-memory fixture construction rejects
cyclic or over-deep graphs before evaluation.

## PostgreSQL relation model

Ordinal migration 3 adds concrete tables rather than a polymorphic relation
tuple table:

- `organizations`, `space_memberships`, `teams`, `team_memberships`, and
  `team_nestings`;
- `project_grants`, `repository_grants`,
  `scm_installation_repository_grants`, and `device_managers`;
- dedicated authorization-scope rows for Session, Memory, Work Thread, and
  Work handoff resources;
- separate Session-metadata, Session-content, Memory-content, Work-Thread, and
  Work-handoff grant tables;
- `authorization_audit_events`.

Subject exclusivity, concrete foreign keys, non-null Space keys, composite
Space/resource foreign keys, partial uniqueness, expiry, revocation state, and
reverse-listing indexes are schema constraints. There is no
`authorization_relations` table, generic relation interpreter, policy language,
or external authorization service.

Every target relationship mutation shares one PostgreSQL transaction
with its content-free audit event. Organization bootstrap creates the
organization, first admin membership, and audit record atomically. Project
grant/revocation writes and their audit records are also atomic, and revocation
is effective on the next authorization query. Future membership, Device,
archive-policy, and Space-move services must use the same transaction and audit
rule before they are exposed.

Audit events contain stable actor/service, Space, action, subject, result, and
time fields plus bounded non-content details. They do not copy prompts, Memory,
Session content, Work handoffs, secrets, paths, or authorization query text.

## Complete scope and Project listing

`@ai-usage/project-application` owns the first authorization-aware application
service. It requests the complete `view_project` scope, treats the result as
opaque, and passes it to the persistence catalog. It never receives all
Projects and post-filters them.

The PostgreSQL catalog verifies that the scope belongs to its adapter, then
re-evaluates the explicit Project authorization CTE in the same transaction as
the Project join and result pagination. This matters for revocation: even a
scope object materialized before a grant was revoked cannot expose that Project
afterward. Pagination limits returned Projects only; it never limits the
authorization graph. Integration tests compare the joined results with
`Authorizer.check` for every candidate.

Plan-106 PostgreSQL ranking must reuse this shape:

```text
principal + permission + active Space
  -> complete explicit authorization CTE in one transaction
  -> join every eligible candidate
  -> rank and create snippets/counts/cursors
  -> bound returned results
```

Forbidden candidates must not affect rank, count, snippets, IDF/statistics,
thresholds, or cursors. If a complete relation cannot be represented in the
ranking transaction, search fails closed.

## Row-level security

All authorization relation, authorization-scope, and audit tables added by
ordinal migration 3 have RLS enabled and forced. Their policies compare the
row `space_id` with `ai_usage.active_space_id`. The PostgreSQL adapter acquires
one pool client, begins a transaction, calls transaction-local `set_config`,
verifies the returned Space ID, performs the query or mutation, and commits or
rolls back before returning the client. It never uses a session-level setting.

Fine-grained permission logic remains application-owned; RLS is only a coarse
Space fence. Tests use a real non-superuser application role and prove both
that missing context returns zero rows and that an inter-Space insert is
rejected. The plan-102 identity tables retain their composite foreign-key and
application-query isolation; extending RLS to them requires first converting
every identity adapter operation to the same transaction-local context.

The pending migration runner's `verify` mode acquires the advisory lock
and executes `CREATE TABLE IF NOT EXISTS platform_migrations`. A restricted
runtime role therefore needs `USAGE, CREATE` on its schema as well as the
table privileges it exercises, unless deployment runs compatibility checking
with a separate migration role. Never compensate by granting superuser or
`BYPASSRLS` to the application role.

## Measured PostgreSQL baseline

Run the reproducible benchmark in the PostgreSQL-17 development shell:

```sh
nix develop --command bash -lc 'bun run benchmark:authorization'
```

The 2026-08-29 measurement used a disposable local PostgreSQL 17 cluster, a
non-superuser RLS role, 10 warm-up queries, and 250 sequential measured
materializations. The seed contains 50 organization Spaces, 200 Projects and
20 People per Space, three nested Team levels, 120 Team-granted Projects, 40
distributed direct grants, and 40 ungranted Projects per Space. The sampled
Person receives 122 Projects.

| Measure | Result |
| --- | ---: |
| p50 | 3.725 ms |
| p95 | 4.755 ms |
| p99 | 5.670 ms |
| OpenFGA trigger | not fired (`4.755 < 150 ms`) |
| Representative EXPLAIN operator-row visits | 401 |
| Shared buffer hits / reads | 896 / 0 |

The row figure is the sum of `Actual Rows × Actual Loops` over EXPLAIN plan
operators, so it is a repeatable query-work indicator rather than a physical
heap-row count. Latencies are a dated developer-workstation baseline, not a
production SLO.

All five escape triggers were evaluated:

1. Project reverse materialization is below p95 150 ms: not fired.
2. Permission composition has one bounded three-level Team relation: not fired.
3. Aggregate/content separation needs no route/application exception: not fired.
4. The adapter uses focused table/query additions, not two consecutive
   cross-adapter rewrites: not fired.
5. Current same-database transactions need no external consistency token: not
   fired.

If any trigger later fires, pause the affected rollout. Compare OpenFGA against
the unchanged conformance suite, complete in-transaction search scope,
read-after-write behavior, model rollout/rollback, self-hosted lifecycle, and
operational cost before changing the adapter. A later OpenFGA adapter must
materialize every `ListObjects` page into a PostgreSQL-joinable relation under
documented consistency; a truncated page is never a search scope.

## Verification

The focused gates are:

```sh
bun --filter @ai-usage/authorization test
bun --filter @ai-usage/project-application test
bun --filter @ai-usage/postgres-store test
nix develop --command bash -lc 'bun run test:postgres'
bun run test:local-platform
```

The PostgreSQL suite proves unchanged conformance behavior, complete scope,
Project equivalence, stale-scope revocation safety, RLS isolation, transactional
audit, migrations, and server lifecycle. The local-platform probe injects a
failing PostgreSQL connector and requires zero calls.
