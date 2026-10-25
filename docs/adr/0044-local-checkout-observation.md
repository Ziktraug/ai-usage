# ADR 0044: Observe local Checkouts and bind them to Projects without review

- **Status**: Accepted; acknowledgment step loses its reader with ADR 0049 on
  `feat/work-resume-cockpit`; the Memory-kernel half retires in plan 120
  phase B ([ADR 0074](0074-local-only-single-operator-product.md))
- **Date**: 2026-10-07
- **Amends**: 0024, 0042

> Amended 2026-10-24: this record's motivating consumer, Session distillation
> discovery (ADR 0042), is retired by ADR 0049 on `feat/work-resume-cockpit`.
> The Project-source acknowledgments of the fourth Decision paragraph
> (`acknowledgeProjectSourceMapping`, `project_source_mappings`) are read only
> by the distillation runtime and catalogue and by this observer's own
> no-change check, so once ADR 0049 lands they are writes without a reader and
> die with distillation; plan 120 phase B removes them with the rest of the
> Memory kernel. The Checkout binding keeps serving `/projects` until then.
> The canonical-path and worktree grouping plan outlives the binding: ADR 0051
> on that branch applies the same plan for checkout status in its own
> enumeration (`packages/usage-engine-runtime` source adapters), which does not
> read the Memory store, and report Session grouping has its own projection
> (ADR 0074). Under ADR 0075 the tables are kept.

## Context

Session distillation (ADR 0042) discovers Sessions only for a Project that has
an acknowledged Project-source mapping through a Device-local Checkout. Plan
102 specified the Checkout, Repository resolution, review and mapping contracts
and the kernel implements them, but nothing in the real engine ever produced a
Checkout: only the synthetic demo fixtures called the kernel writers. On an
operator store `/projects` therefore reported nothing to review while
`/memory` and `analyses discover` reported `mapping-required`, and the whole
feature was unreachable with real history.

The usage store already publishes the inputs: one local Project source per
(machine, absolute path) with its session count and the `projectSourceId` its
rows carry, and the engine already owns a bounded `.git/config` origin reader
used for Session VCS context. The report groups a linked git worktree (a
`.git` file pointing into the parent's `.git`, or a path under
`.claude/worktrees/`) with its parent repository: the published id is the
parent's `machineId|path` while the source path stays the worktree. That
reader only accepts a `.git` directory, so an out-of-tree worktree reads as
having no remote at all.

## Decision

The usage engine runs local Checkout observation beside the Memory service,
once at startup and after every `report-published` runtime event. Each run
groups this machine's local Project sources (absolute paths, resolved so
`/a/b/` and `/a/b` are one path) by the canonical path their published id
decodes to; a source whose physical path differs from that canonical path is a
worktree. It records one Device-local Checkout keyed by (Device, path) in
`memory.sqlite` for every canonical path, even when no session ran there, and
one for every worktree, refreshing status, remote and observation time without
changing identity, Project, Repository or review state.

Resolution runs for an available Checkout that has no Project and no reviewed
decision, including again when such a Checkout's observed remote changes; a
bound or reviewed Checkout keeps its decision. Canonical paths resolve first,
on their own remote. The policy is local-first and single-operator:

- a remote that resolves to a known Repository binds to that Repository's
  root Project, creating the Project if needed;
- a remote with no known Repository creates the Repository with its
  `local-git` alias and binds the same way;
- no remote creates a local Project named after the directory;
- an ambiguous remote records its candidates and waits in the `/projects`
  resolution review; nothing else enters review, and missing paths are
  recorded but never resolved or reviewed until they are seen again.

A worktree then follows its canonical Checkout: when that Checkout is bound to
a Repository Project through a Repository, the worktree links to the same
Project and Repository without consulting its own remote. Otherwise (canonical
unbound, ambiguous, missing or a remote-less local Project) the worktree
resolves on its own by the policy above. The same link repairs a worktree that
an earlier run bound to its own remote-less local Project. A Checkout with an
observed remote or a Repository of its own is never relinked, and operator
review only ever happens for a remote-bearing ambiguous Checkout, so the
repair cannot undo a decision while that remote is still observed. Bindings
record no provenance: a reviewed Checkout whose remote later reads as absent
would be relinked like an automatic one. The superseded local Project stays,
without a mapped Checkout.

Every bound canonical Checkout acknowledges each published id that decodes to
its path as `id → (Project, Checkout)`, so discovery matches the ids rows
actually carry; every bound worktree acknowledges its own `machineId|path`,
which no row carries, so a `--checkout` selector inside the worktree resolves
to that Checkout. A successful review action triggers one more observation
before the reply so the mapping follows the operator's decision immediately.
Diagnostics carry counts and a closed failure vocabulary, never a path, remote
or error message, and never affect engine readiness.

## Consequences

- `/memory` discovery, the `/projects` review and `analyses discover` work on
  real stores without manual kernel seeding.
- Every directory the operator has run a harness in becomes a Project, one per
  Repository across its worktrees, mirroring the usage report's own grouping;
  a worktree's Sessions are discoverable even when no Session ever ran in the
  parent directory, and stores written before canonical observation are
  repaired on the next run.
- Rename or transfer detection and monorepo subpath Projects stay out of
  scope; a Checkout keeps its first binding until the operator changes it,
  apart from the worktree repair above.
- Rejected alternative: queue every new Checkout for human review. The review
  card shows an opaque `checkout:` label by design (paths stay private), so a
  review per directory would be undecidable noise for the common local case.

## Evidence

- `apps/usage-engine/src/checkout-observation-runtime.ts` and its test.
- `projectSourcePathFromId` in `packages/report-core/src/project-group.ts` and
  `ServedLocalProjectSource.projectSourceId` in `packages/usage-store`.
- `LocalIdentityKernel.observeCheckout` / `findProjectByRepository` in
  `packages/memory-sqlite/src/identity.ts`.
- `docs/session-distillation.md` (operator flow) and
  `docs/architecture.md` (usage engine composition).
