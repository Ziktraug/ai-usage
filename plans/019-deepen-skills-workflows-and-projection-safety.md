# Plan 019: Deepen Skills Workflows and Harden Projection Parents

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 009 only; may run alongside plans 011-018
- **Category**: security hardening / architecture / tests
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `refactor/019-skills-application-safety`

## Executor instructions

Read this plan completely and compare current Skills code with `17bcf28`. Fix
projection parent safety before moving workflow ownership. Use temporary
filesystems and subprocesses; never reconcile the developer's real Skills
directories in tests.

Document the threat model honestly. Portable Node APIs can prevent common
symlink/identity races between scan and mutation, but do not provide a complete
`openat`/dirfd guarantee against a malicious same-UID actor in every syscall
micro-window.

## Why this matters

Projection planning validates a target leaf, but apply can recursively create a
parent and mainly revalidates the leaf before mutation. If the target directory
or an ancestor changes between scan/plan and apply, a mutation can land in an
unexpected tree. Multiple ai-usage reconcilers are also not serialized per
target.

At the same time, `apps/web/src/server/skills.server.ts` orchestrates many
low-level workflow functions itself and duplicates bounded Markdown reads. The
package exposes primitives, while the web adapter owns application use cases.
That makes non-web reuse harder and splits safety/business invariants across two
layers.

## Target outcome

1. Projection apply mutates only an explicitly selected and observed target, or
   a target created and then re-observed through a fresh plan.
2. Target/parent canonical identity is captured during planning and revalidated
   under a per-target interprocess lock before mutation.
3. Symlink/identity replacement aborts without touching the replacement tree.
4. `@ai-usage/skills` owns complete snapshot, inventory, config, reconcile, and
   Markdown use cases behind narrow ports.
5. The web server adapter validates JSON, supplies ports, and maps JSON-safe
   results; it no longer reorchestrates domain workflows.
6. One bounded regular-file Markdown reader owns limits/no-follow behavior.
7. Package boundaries remain acyclic and existing Skills UX/semantics remain.

## Current-state evidence

- `packages/skills/src/projections.ts` plans/revalidates a target leaf but
  mutations occur after separate filesystem observations.
- `packages/skills/src/workflows.ts:applyProjectionAction` can call recursive
  `mkdir`, allowing an unobserved target/ancestor to appear during apply.
- There is no per-target interprocess serialization for cooperating ai-usage
  reconcilers.
- `apps/web/src/server/skills.server.ts` receives/exposes roughly ten workflow
  functions and combines them into use cases in the web layer.
- It defines a bounded project `SKILL.md` read parallel to the package's
  filesystem helper.
- Current server tests wrap every low-level workflow, proving wiring but keeping
  application ownership in the wrong layer.

## Scope

### In scope

- Skills projection contracts/planning/apply and target creation;
- per-target lock and parent/target identity validation;
- a package-level Skills application module and tests;
- filesystem/config/project-path ports;
- web server adapter simplification and JSON/error tests;
- duplicate bounded Markdown read removal.

### Out of scope

- adding "Adopt into source" for unmanaged skills;
- changing current source/runtime projection semantics or UX;
- native addons for universal `openat`/dirfd race elimination;
- importing report-data, local-collectors, Solid, or web server types into the
  Skills package;
- changing config fields outside the Skills section;
- scanning arbitrary new roots.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- packages/skills/src apps/web/src apps/web/e2e
git status --short -- packages/skills/src apps/web/src apps/web/e2e
bun test packages/skills/src/projection.test.ts \
  packages/skills/src/snapshot.test.ts \
  apps/web/src/server/skills.server.test.ts
```

If either scoped drift command contains changes beyond completed plan 009,
STOP, preserve them, and re-characterize target identity/application boundaries
after rebasing before editing.

## Threat model and invariant

The required invariant is:

> A projection action may modify a leaf only when the explicitly selected target
> directory is still the same non-symlink directory observed during planning and
> every allowed pre-existing parent component resolves through the same observed
> lexical/canonical identity chain.

The implementation protects against accidental changes, symlink swaps between
phases, and cooperating concurrent ai-usage processes. If protecting against a
hostile same-UID process inside the final syscall window is required, STOP and
propose a platform-specific dirfd/native design rather than overstating safety.

## Implementation steps

### Step 1 - Add adversarial projection tests

Extend `packages/skills/src/projection.test.ts` and a subprocess fixture to
cover:

1. target directory replaced by a symlink between plan and apply;
2. target directory replaced by another directory/inode;
3. observable parent replaced or canonical path changed;
4. target removed after planning;
5. two cooperating reconcilers apply to one target concurrently;
6. existing create, repair, install, claim, and unlink actions;
7. no mutation in an interloper directory and no partial leaf/temp residue;
8. a pre-existing unchanged parent symlink used by a supported target remains
   accepted, while replacing its link or resolved directory aborts;
9. lock acquisition timeout, live heartbeat, dead-owner/stale recovery, and a
   crash-killed subprocess cleanup/recovery.

Use filesystem identity fields supported on the platform (canonical path,
device/inode where meaningful, type, and relevant parent identity). Make
platform limitations explicit in tests rather than silently omitting them.

### Step 2 - Separate target creation from projection apply

1. Remove recursive target creation from `applyProjectionAction`.
2. Add/retain an explicit `createSkillTargetDirectory` use case that validates
   the configured root/target and returns an observed target identity.
3. A projection plan for a missing target must instruct the caller to create and
   rescan/replan; apply never invents the target implicitly.
4. Persist the observed target and required ancestor identity in the internal
   plan/action contract. Starting at the configured authorization root, record
   each lexical component's type/device/inode; for an allowed pre-existing
   parent symlink also record link text plus the canonical resolved directory
   identity. The target leaf itself remains a non-symlink directory, matching
   current `lstat(...).isDirectory()` behavior. Do not trust a caller path alone.
5. Preserve JSON-safe preview output without exposing sensitive absolute
   identities unnecessarily to the browser.
6. Treat target creation as a concurrent mutation, not a pre-lock helper. For a
   missing target, derive the lock identity from the canonical nearest existing
   authorized parent plus the normalized remaining lexical components. Use the
   same derivation for an existing target so creation and apply contend on one
   key.
7. Acquire that lock before revalidating the authorization/ancestor chain, then
   create missing directory components one at a time (non-recursive), checking
   each new component with `lstat`/identity before continuing. Never use a blind
   recursive `mkdir` across unobserved parents.
8. If a cooperating creator wins, accept only a complete rescan that proves the
   resulting non-symlink target and ancestor chain are authorized; return an
   `already-created/replan-required` outcome and build a fresh projection plan.
   A parent swap or incompatible object aborts with no projection mutation.

### Step 3 - Serialize and revalidate under a target lock

1. Put locks outside the replaceable target tree in the injected owner-only
   ai-usage private state root:
   `skills-projection-locks/<sha256(target-lock-identity)>.lock`, where
   `target-lock-identity` is the canonical target when present or the canonical
   nearest existing authorized parent plus normalized missing lexical
   components. Validate/create the lock directory as non-symlink `0700` and lock
   files as exclusive no-follow regular `0600` files with one link.
2. Reuse/extract the existing `filesystem.ts` lock protocol and constants:
   10 s acquisition timeout, 10 ms retry, 250 ms heartbeat, 2 s lease,
   30 s hard expiry, and 1 KiB metadata cap. Keep owner UUID/PID/hostname,
   identity-checked removal, heartbeat, dead-local-PID recovery, and hard-expiry
   recovery; do not invent an unbounded wait or age-only unlock. As in the
   existing protocol, hard age alone never steals a lock whose heartbeat is
   fresh; a long valid projection remains serialized.
3. Acquire the central interprocess lock before revalidation/mutation.
4. Re-read the complete lexical/canonical component chain, including every
   recorded parent symlink and resolved identity, while holding the lock.
5. Reject a new/replaced symlink, non-directory target, missing component, or
   changed link/canonical identity. Do not globally reject an unchanged
   pre-existing parent symlink that the characterized current target supports.
6. Revalidate the leaf immediately before claim/install/unlink and use existing
   atomic replacement semantics.
7. Release/clean the lock on success/error; after a killed process, the
   heartbeat/stale-owner protocol must make later recovery bounded.
8. Never follow a newly introduced symlink merely to report or repair it.

Tests must prove cooperating reconcilers serialize and a changed target causes
zero mutation. They must also race two target creators and swap a parent during
creation; only one safe target may result, no creator may project as part of
creation, and both callers must rescan/replan before apply.

### Step 4 - Define a deep Skills application interface

Create `packages/skills/src/application.ts` with complete use cases for the
current product surface:

- management snapshot and project inventories;
- authorized bounded project/source `SKILL.md` reads;
- managed source Markdown read/save;
- Skills config read/update/toggle while preserving non-Skills fields;
- target creation;
- reconcile preview/apply;
- individual projection actions.

Inject narrow ports for:

- read/update of the Skills config section;
- curated project paths supplied by the host;
- home/configured roots;
- the package filesystem abstraction and clock/lock only where needed.

The application owns ordering, authorization, consistency, and domain error
translation. It must not import report-data, local-collectors, web contracts, or
server functions.

### Step 5 - Consolidate bounded Markdown reads

Use one `readBoundedRegularFile`-style package helper for project/source
Markdown. It must enforce the existing byte limit, no-follow regular-file
policy, UTF-8/error behavior, and allowed-root authorization before returning
content.

Delete `readBoundedProjectSkillMarkdownFile` from the web server once all use
cases delegate to the application. Do not weaken project-path curation or let a
browser request arbitrary paths.

### Step 6 - Move end-to-end workflow tests into the package

Move the current server test scenarios that exercise actual business workflows
to `packages/skills/src/application.test.ts`. Cover:

- snapshot/inventory;
- config toggle/update preserving unrelated config;
- Markdown read/save authorization and size/symlink failures;
- reconcile preview/apply and hardened target identity;
- typed errors and cleanup.

Retain focused web adapter tests only for:

- input validation;
- port wiring;
- JSON-safe conversion;
- domain error to server-result mapping;
- no real HOME/filesystem access in E2E fixture mode.

### Step 7 - Reduce the web adapter

Refactor `apps/web/src/server/skills.server.ts` so it:

1. validates server-function input;
2. builds/injects production ports from local-collectors/report-data only at the
   host boundary;
3. calls one Skills application use case;
4. converts the result to existing JSON-safe contracts.

Delete the broad workflow bag and web-owned orchestration. Keep current public
server function names/results unless an internal-only name can be removed safely.

After all consumers move, remove direct mutation bypasses from
`packages/skills/src/index.ts`: raw `applyProjectionAction`, target creation by
untrusted path, reconcile/toggle/config/source-state/Markdown write functions,
and equivalent mutation workflows are internal implementation details. Export
the deep application factory/use-case interface instead. Pure parsers and
read-only scans may remain public. Add an export-surface test so callers cannot
bypass application authorization/locking through the package root.

## Test plan

```sh
bun test packages/skills/src/projection.test.ts \
  packages/skills/src/application.test.ts \
  apps/web/src/server/skills.server.test.ts \
  apps/web/src/server/skills-e2e-fixture.server.test.ts
CI=1 bun run --cwd apps/web test:e2e -- e2e/skills.spec.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Done criteria

- Apply never recursively creates an unobserved target.
- Target creation uses the same per-target lock as apply, validates each created
  component, and forces a fresh plan.
- Target/parent identity changes and symlink swaps abort without interloper
  mutation.
- Cooperating reconcilers serialize per target.
- One package application owns all current Skills use cases.
- No root-package mutation export bypasses the application.
- One bounded/no-follow Markdown reader remains.
- Web tests cover adapter behavior; package tests cover business workflows.
- Config fields outside Skills and all existing user-visible behavior remain.
- Package boundary checks pass.

## STOP conditions

- The desired threat model requires a universal hostile same-UID guarantee that
  Node path APIs cannot provide; request a native/platform decision.
- Apply still creates a target or trusts only a caller path after planning.
- An ancestor symlink/identity change can direct mutation elsewhere.
- A lock lives inside the target tree, waits unboundedly, can be stolen during a
  live heartbeat, or lacks crash/stale-owner tests.
- `@ai-usage/skills` must import report-data, local-collectors, web, or Solid.
- The web adapter still owns business sequencing after extraction.
- A direct mutation workflow remains exported from the package root.
- Config updates overwrite unrelated fields.
- Tests touch real HOME or managed Skills directories.

## Maintenance note

New Skills mutations belong in the application module and must carry an explicit
authorization root, bounded/no-follow I/O policy, observed target identity,
concurrency policy, preview semantics, and temp-filesystem tests.
