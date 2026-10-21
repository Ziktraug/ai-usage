# ADR 0052: Review routing qualification: declared executors, observed availability, observed quota

- **Status**: Accepted
- **Date**: 2026-10-21
- **Extends**: 0009, 0016, 0017, 0045

## Context

The Work view simulates assigning a read-only review of a session to a local
harness (Claude Code or Codex). Before this decision the only input was the
stored quota (`ProviderStatus`), from which candidates were fabricated with
every execution field unknown, so the simulation could never choose in live
mode. Quota is also the wrong source for most of those fields: it says nothing
about whether a harness is installed or signed in, nothing about billing, and
nothing about whether the operator allows it to act. The live quota keys carry
no account suffix (`claude`, `codex`), so an account could not be read from
them either.

## Decision

A review candidate is assembled from three sources that never substitute for
one another, and every field records which one it came from
(`declared`, `observed-now`, `stale`, `unknown`):

- **Declared** (`~/.config/ai-usage/config.json`, `routing.executors[]`,
  home-only, read never written by the app): account scope, authorization,
  admissible targets, subscription (`verified` or `api`), capabilities,
  quality, optional model and effort, and a required `declaredAt`. This is
  the only source of authorization and of subscription status. A quota never
  authorizes, and the observed plan is shown beside the declaration as
  evidence, never used to infer `verified`.
- **Observed availability** (`executors.capabilities` source, 15-minute
  cadence, table `executor_observations`): binary present, version, and the
  sign-in state reported by the harness's own non-interactive status command
  (`claude auth status --json` `loggedIn`; `codex login status` exit code).
  No credential file is read and nothing is generated. Evidence is a bounded
  classification built from exit codes, never raw output.
- **Observed quota** (unchanged, ADR 0045): the stored provider status, aged
  by the feed rule.

A declaration binds a quota stream for its harness family on its machine.
When the stored key has no account suffix, the one declaration for that family
and machine binds it; a second declaration for the same family and machine, or
account-scoped streams that match no declaration, are reported as ambiguous
with the exact fix, never guessed. Several models on one account are one
resource: model-scoped windows of another model are not counted and are never
summed with the windows that apply; an undeclared model with model-scoped
windows present is excluded with the action to declare it.

The simulation stays pure and deterministic (constraints before preferences,
no percentage comparison across offers, resets never grant authorization). Its
outcome is labelled: `real` when the chosen candidate rests on declared and
currently observed facts only; `conditional` when no candidate is eligible but
one would be with exactly one named observation that is missing or stale; else
`none`. A conditional result never permits a launch, and no result starts
anything.

Missing data is answered with a precise, realizable action on the candidate
(add the declaration entry, sign the CLI in, install it, refresh the quota or
executor observation, declare the model, adjust the target), not with a form
per card.

## Consequences

- Live routing can now choose, and only when the operator has declared the
  route and the engine has observed the harness signed in with fresh quota.
- Observations qualify routing and are not report data: the new table never
  advances the store generation, never enters a served revision, snapshot or
  replication, and the source reports `changed: false`.
- The store schema stays at usage version 4; the table is created on presence.
- The declaration file is edited by hand for now; a CLI command to write it is
  a later step.

## Limits

- Nothing verifies billing beyond the declaration: `subscription: 'verified'`
  is the operator's statement. The observed plan name is a hint, not proof,
  and "no API key found" would not be proof of non-billing either.
- Sign-in state is only as good as the CLI's non-interactive status command.
  A CLI without one yields `unknown`, never a guess from files on disk.
- Freshness is judged against fixed budgets (quota 15 minutes, executors
  twice the 15-minute cadence); an observation past them is `stale`, which
  blocks a `real` recommendation and can only make one `conditional`.

## Rejected alternatives

- Deriving the account from the quota key: the live collectors record no
  account suffix, so there is nothing to derive.
- Inferring `verified` from an observed subscription plan: a plan name is a
  provider's label for a product, not a confirmation of how this route bills.
- Reading `~/.claude/.credentials.json` or `~/.codex/auth.json` for the
  sign-in state: a credential file is never an acceptable input.

## Evidence

- `packages/report-core/src/work-executors.ts` (declarations, observations,
  parsers and bounds) and `work-routing.ts` (`qualifyReviewCandidates`,
  `assessReviewRecommendation`), with `work-routing.test.ts`.
- `packages/local-collectors/src/executor-observations.ts`,
  `packages/usage-store/src/executor-observation-store.ts`,
  `packages/usage-engine-runtime/src/source-adapters.ts`
  (`executors.capabilities`).
- `packages/web-contract/src/work-routing.ts`,
  `apps/web/src/server/work-routing-context.server.ts`,
  `apps/web/src/lib/features/work/work-routing.svelte`.
- `README.md` "Declare which local harness may run a read-only review" and
  `docs/local-store-upgrade.md` "Additive tables under usage version 4".
