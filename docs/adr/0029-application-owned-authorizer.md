# ADR 0029: Application-owned Authorizer

- **Status**: Accepted; amended by
  [ADR 0074](0074-local-only-single-operator-product.md); retires with accepted
  Memory in plan 120 phase B
- **Date**: 2026-08-29
- **Amended by**: [ADR 0074](0074-local-only-single-operator-product.md)

> Amended 2026-10-24 (ADR 0074): only the local half remains.
> `SingleUserAuthorizer` stays as a fail-closed fence for the one local Person
> and personal Space while accepted Memory exists; the organization model and
> its PostgreSQL adapters are withdrawn (plan 120 phase A strips them from
> `packages/authorization`), so the connected-mode sentence and the connected
> motivation are removed below. Local Memory search keeps joining the complete
> authorized scope before ranking, the one rule carried from the superseded
> ADR 0034. When phase B removes accepted Memory, this record retires with the
> package if nothing else needs it.

## Context

Local services need one way to make permission decisions without putting
policy in routes, MCP tools, UI filters, or database adapters. An
unconditional allow-all stub would hide Space and principal errors.

## Decision

The application boundary owns an `Authorizer` port with explicit check,
bounded authorized-resource-list, and complete opaque resource-scope
operations. Decisions distinguish allow, deny, and authorization
infrastructure error; errors never become allow. Complete scope has no
arbitrary pre-ranking cap and is consumed only by persistence adapters.

Local mode composes `SingleUserAuthorizer` for the bootstrapped Person and
personal Space. It permits only the local principal over resources in that
Space and denies or fails non-local and organization contexts.

Application services authorize before content access or mutation. HTTP routes,
MCP tools, serializers, jobs, and UI filtering do not implement permission
logic. Every adapter passes the same golden scenarios, including aggregate
versus content separation and complete authorized-resource listing.

Authorization-aware persistence queries re-evaluate current relations in the
same transaction as protected reads when stale scope could otherwise race a
revocation. The scope object is a capability handle, not a reusable ACL array.

## Consequences

- The single-user value path can land before full ReBAC without creating a
  second permission model.
- Authorization failures remain typed and fail closed.
- Storage and external engine choices stay replaceable behind conformance.

## Rejected alternative

Route-local checks were rejected because different edges could disagree and
background jobs or search could bypass them.

## Reversal condition

Revise the port only if measured domain scenarios cannot express a bounded
check or complete resource listing without leakage; preserve the golden suite
and migrate every adapter atomically.

## Evidence

- [Application-service architecture](../architecture.md#application-services-and-trusted-capabilities)
- [Plan 102](../../plans/102-spaces-people-devices-repositories-projects.md)
- [Plan 103](../../plans/103-rebac-authorization-content-boundaries.md)
