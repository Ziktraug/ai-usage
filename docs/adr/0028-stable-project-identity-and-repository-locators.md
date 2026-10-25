# ADR 0028: Stable Project identity and Repository locators

- **Status**: Accepted; amended by
  [ADR 0074](0074-local-only-single-operator-product.md); retires with accepted
  Memory and `/projects` in plan 120 phase B
- **Date**: 2026-08-29
- **Amended by**: [ADR 0074](0074-local-only-single-operator-product.md)

> Amended 2026-10-24 (ADR 0074): the cross-device motivation is withdrawn. The
> Project, Repository and Checkout binding is local: it serves accepted Memory
> and the `/projects` resolution review on one operator's machines, and the
> Space is the one personal Space the Memory store creates on first open, kept
> in the schema without a migration. "Cross-device" and the Work handoff
> consumer (ADR 0032, retired) are removed from the Context and the first
> Decision sentence. Report Session grouping never used
> this binding (ADR 0074). When phase B removes accepted Memory and
> `/projects`, this record retires.

## Context

Current report Project sources are machine-and-path identities and Project
groups are local presentation configuration. Memory needs a durable work
identity, while repository URLs, slugs, paths, and remotes change and do not
cover non-Git or monorepo-subpath work.

## Decision

`ProjectId` is the stable identity. A Project belongs explicitly
to a Space and may optionally reference a Repository and repository subpath.
Non-Git Projects are valid.

A Repository is a separate stable, Space-scoped source-control identity.
Verified provider repository IDs and normalized historical aliases are
locators, not Project primary keys. A Checkout is a Device-local path/remote
observation that may resolve to a Project and Repository. Rename, transfer,
remote, path, or Device changes preserve Project identity; ambiguous aliases
fail explicitly and never cross Space.

Existing Project source and Project group semantics remain unchanged. Platform
resolution is additive and missing mapping is a visible gap, not a guessed
global Project.

## Consequences

- Repository rename and checkout relocation do not fracture Memory or Work
  continuity.
- Mirrors, self-hosted repositories, monorepo subpaths, and local projects stay
  representable without unsafe auto-merge.
- Resolution needs provenance, alias history, and explicit ambiguity outcomes.

## Rejected alternative

Using normalized repository URL plus path as Project identity was rejected
because it changes across rename/transfer, collides across hosts, and excludes
non-Git work.

## Reversal condition

Adopt an external project identifier only if it is provider-independent,
supports non-Git and subpath Projects, is stable across transfer, and a
reviewed migration preserves every existing Project reference and Space fence.

## Evidence

- [Ubiquitous language](../../CONTEXT.md)
- [Plan 102](../../plans/102-spaces-people-devices-repositories-projects.md)
