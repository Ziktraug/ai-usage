# ADR 0029: Application-owned Authorizer

- **Status**: Accepted
- **Date**: 2026-08-29

## Context

Local single-user services and connected organization services need one way to
make permission decisions without putting policy in routes, MCP tools, UI
filters, or database adapters. Local Memory must not wait for the full
organization model, but an unconditional allow-all stub would hide Space and
principal errors.

## Decision

The application boundary owns an `Authorizer` port with explicit check,
bounded authorized-resource-list, and complete opaque resource-scope
operations. Decisions distinguish allow, deny, and authorization
infrastructure error; errors never become allow. Complete scope has no
arbitrary pre-ranking cap and is consumed only by persistence adapters.

Local mode composes `SingleUserAuthorizer` for the bootstrapped Person and
personal Space. It permits only the local principal over resources in that
Space and denies or fails non-local and organization contexts. Connected mode
composes explicit PostgreSQL organization queries constrained by the shared
relationship model and conformance suite.

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
