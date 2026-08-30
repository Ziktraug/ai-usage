# ADR 0030: PostgreSQL domain authorization before OpenFGA

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

The first connected resource graph is bounded to Spaces, memberships, teams,
Projects, Repositories, Devices, Sessions, Memory, Work Threads, Work handoffs,
and aggregate projections. A generic Zanzibar interpreter or external service
would add model rollout, datastore consistency, reconciliation, and operations
before the graph or performance requires them.

## Decision

V1 organization authorization uses application-owned domain-specific
PostgreSQL relation tables and explicit indexed queries behind the `Authorizer`
port. Relationship writes commit with their business entities. A recursive CTE
may implement a concrete bounded domain relation such as nested teams; there is
no generic relation tuple table, customer policy language, or permission DSL.

PostgreSQL RLS adds a coarse Space fence to the authorization relation,
authorization-scope, and audit tables. The non-superuser application role sets
and verifies transaction-local context on one reserved pool client. RLS is
defense in depth, not the application authorization owner.

OpenFGA is evaluated only when at least one measured trigger fires:

1. Project reverse listing/materialization exceeds p95 150 ms at 50 Spaces ×
   200 Projects × 20 People with realistic team nesting;
2. permission composition becomes materially deeper than three relation steps;
3. a required relation cannot be implemented without an application-side or
   route-specific exception;
4. two consecutive permissions require bespoke cross-adapter rewrites instead
   of a focused domain query/table addition;
5. external consistency tokens or semantics become necessary.

A trigger pauses rollout for a comparison proving the unchanged conformance
suite, complete search-scope materialization, model rollout/rollback,
read-after-write behavior, self-hosted lifecycle, and operational cost.

## Measured trigger evaluation

On 2026-08-29, the reproducible PostgreSQL-17 benchmark seeded 50 organization
Spaces × 200 Projects × 20 People, three nested Team levels, and a mix of Team,
direct, and absent grants. After 10 warm-ups, 250 complete Project-scope
materializations produced p50 3.725 ms, p95 4.755 ms, and p99 5.670 ms. The
representative EXPLAIN recorded 401 summed operator-row visits and 896 shared
buffer hits with no reads. The performance trigger did not fire.

The remaining triggers also did not fire: composition has one bounded
three-level recursive Team relation; aggregate/content separation uses distinct
queries without route exceptions; new permissions remain focused table/query
additions; and same-database relation/business transactions need no external
consistency token. These are dated implementation findings and must be
re-evaluated when the graph or deployment changes.

## Consequences

- V1 relation and business writes share transactions and one failure domain.
- Permission queries remain explicit, reviewable, and indexable.
- The port and scenarios preserve a measured path to OpenFGA without making it
  a speculative dependency.

## Rejected alternative

A generic Zanzibar-like DSL/interpreter in application code was rejected
because the current graph does not justify a new policy language or its
consistency machinery.

## Reversal condition

Adopt OpenFGA only after a documented trigger fires and the comparison passes;
its datastore still does not become authority for application business rows.

## Evidence

- [Authorizer decision](0029-application-owned-authorizer.md)
- [Authorization model, RLS, and benchmark](../authorization.md)
- [Plan 103](../../plans/103-rebac-authorization-content-boundaries.md)
