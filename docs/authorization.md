# Authorization model

> **Implementation status:** Integrated on `main` via PR #53 (plan 103
> `DONE`). Plan 120 removed the organization authorizer and policy model, the
> in-memory and PostgreSQL adapters, and their conformance fixture; only the
> local single-user policy remains. `@ai-usage/authorization-contract` still
> lists the organization-era permissions `manage_authorization`,
> `manage_members`, `manage_organization`, `manage_teams`, `view_organization`,
> and `view_organization_usage_aggregate`. None of them is in the single-user
> allow set, so each fails closed with
> `single-user.permission-resource-mismatch`. Plan 120 phase B removes them,
> and the authorization packages if nothing outside accepted Memory still
> needs them.

This is the reference for the local authorization seam: the application-owned
`Authorizer` port and the `SingleUserAuthorizer` policy that the local Memory
service runs before every read or mutation.

## Application boundary

`@ai-usage/authorization` (re-exporting the portable contract from
`@ai-usage/authorization-contract`) owns one tri-state port:

- `check` returns allow, deny, or a typed operational error;
- `listResources` returns a bounded ordinary page with a principal-, Space-,
  permission-, and resource-kind-bound opaque cursor;
- `materializeResourceScope` returns a complete opaque authorization scope or
  a typed error. It never returns a partial scope or applies a pre-ranking cap.

Every request names a principal, permission, resource kind, active Space, and
trusted-Device condition. A missing or mismatched active Space fails closed.
The permission/resource map is explicit code
(`@ai-usage/authorization/permission-resource`), not a policy DSL. Decision and
error traces carry rule/operation identifiers only; they never include source
context, prompts, or Memory content.

Routes, MCP tools, serializers, UI filters, and jobs do not implement a second
ACL. They call an application service, which calls the `Authorizer` before a
content read or mutation. Browser and CLI production dependency closures are
guarded from the authorization implementation (`tools/check-package-boundaries.ts`).

## Single-user policy

`SingleUserAuthorizer` (`@ai-usage/authorization/single-user`) is built from the
bootstrapped local Person and personal Space of the identity kernel
([identity kernel](identity-kernel.md)). It:

- allows only that Person, and only over resources in that personal Space whose
  kind the permission supports;
- denies a foreign Space, an active-Space mismatch, a non-local or service
  principal, and a permission/resource mismatch, each with its own rule ID
  (`packages/authorization/src/single-user.test.ts` pins the local operator's
  decision for every supported permission/resource pair);
- turns an unavailable store into an `error` decision, never into allow or deny;
- lists resources Space-scoped, sorted by ID, cursor-paged, at most 100 items
  per page.

## Complete scope

`materializeResourceScope` returns an opaque, frozen scope object. Its resource
IDs live in a module-private `WeakMap` inside
`@ai-usage/authorization/scope-internal`; only the persistence adapter
(`@ai-usage/memory-sqlite`) and test fixtures may read them, which the package
boundary check enforces. The adapter also rejects a scope whose model version,
permission, resource kind, or active Space does not match the query.

Memory search follows ADR 0034: materialize the complete authorized scope first,
then join, rank, count, and page only inside it. Forbidden candidates never
affect rank, counts, snippets, statistics, or cursors; a scope that cannot be
materialized fails the search closed.

## Verification

The focused gates are:

```sh
bun --filter @ai-usage/authorization test
bun test tools/check-package-boundaries.test.ts
```
