# ADR 0044: Observe local Checkouts and bind them to Projects without review

- **Status**: Accepted
- **Date**: 2026-10-07
- **Amends**: 0024, 0042

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
(machine, absolute path) with its session count, and the engine already owns a
bounded `.git/config` origin reader used for Session VCS context.

## Decision

The usage engine runs local Checkout observation beside the Memory service,
once at startup and after every `report-published` runtime event. For each
local Project source of this machine with an absolute path it records one
Device-local Checkout keyed by (Device, path) in `memory.sqlite`, refreshing
status, remote and observation time without changing identity, Project,
Repository or review state.

Resolution runs only for an available Checkout that has no Project and no
reviewed decision, and again when its observed remote changes. The policy is
local-first and single-operator:

- a remote that resolves to a known Repository binds to that Repository's
  root Project, creating the Project if needed;
- a remote with no known Repository creates the Repository with its
  `local-git` alias and binds the same way;
- no remote creates a local Project named after the directory;
- an ambiguous remote records its candidates and waits in the `/projects`
  resolution review; nothing else enters review, and missing paths are
  recorded but never resolved or reviewed until they are seen again.

Every bound Checkout acknowledges the mapping
`machineId|path → (Project, Checkout)`. A successful review action triggers one
more observation before the reply so the mapping follows the operator's
decision immediately. Diagnostics carry counts and a closed failure vocabulary,
never a path, remote or error message, and never affect engine readiness.

## Consequences

- `/memory` discovery, the `/projects` review and `analyses discover` work on
  real stores without manual kernel seeding.
- Every directory the operator has run a harness in becomes a Project, one per
  Repository across its worktrees, mirroring the usage report's own grouping.
- Rename or transfer detection and monorepo subpath Projects stay out of
  scope; a Checkout keeps its first binding until the operator changes it.
- Rejected alternative: queue every new Checkout for human review. The review
  card shows an opaque `checkout:` label by design (paths stay private), so a
  review per directory would be undecidable noise for the common local case.

## Evidence

- `apps/usage-engine/src/checkout-observation-runtime.ts` and its test.
- `LocalIdentityKernel.observeCheckout` / `findProjectByRepository` in
  `packages/memory-sqlite/src/identity.ts`.
- `docs/session-distillation.md` (operator flow) and
  `docs/architecture.md` (usage engine composition).
