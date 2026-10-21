# ADR 0051: Engine-side read-only GitHub and checkout status observation

- **Status**: Accepted
- **Date**: 2026-10-21
- **Extends**: 0009, 0044

## Context

The Work view confronts what a Session declares about itself ("pull request
opened", "blocked until the commit lands") with what the outside world shows.
Two sources of that evidence exist on the operator's machine already: the
GitHub CLI, signed in with the operator's own accounts, and the working trees
the harnesses ran in. Until now the product touched neither from the engine.
The web server ran `gh pr list` on demand for one session (session VCS
context), and ADR 0044 recorded that a checkout exists, without looking at its
state.

Both reads are cheap, both are bounded, and both carry risk if done
carelessly: a `gh` call can prompt, page, or print a token in a diagnostic; a
`git` call can refresh the index, trigger a filesystem monitor, or run a hook.
The facts they produce must also stay what they are: dated looks, never the
current state, and never a verdict.

## Decision

The usage engine, the only writer of the usage store (ADR 0009), runs two
scheduled producers beside the session sources:

- `checkouts.status` (every 5 minutes) runs `git status --porcelain=v2
  --branch --untracked-files=normal` and `git log -1 --format=%cI` on every
  known checkout: the canonical paths and linked worktrees of the served local
  Project sources (the same plan as ADR 0044) plus candidates another
  collector injects. Both commands run with `--no-optional-locks`,
  `core.fsmonitor=false`, no terminal prompt and a fixed locale. No other
  `git` command is ever issued; file contents are never read.
- `github.pull-requests` (every 10 minutes) runs `gh pr view <n> --repo
  <owner/name> --json …` for pull requests that a Session explicitly recorded
  in its VCS context or that another collector injects, never for a pull
  request inferred from a branch name or from proximity in time. Only
  `github.com` is supported; other hosts are recorded as `disabled`.

Both go through one shared bounded runner: no shell, an explicit environment
allow-list (PATH, HOME, LANG, LC_ALL, TZ, XDG_*, plus variables named by the
caller), a deadline and an output ceiling enforced with SIGKILL, fatal UTF-8
decoding, and stderr drained and never retained. Failures are classified from
exit codes and stdout alone: `gh` exit 4 is "authentication required"; any
other silent failure is followed by one REST read whose error body `gh`
prints on stdout, so HTTP 404 becomes `not-found`, HTTP 401 becomes
`unauthenticated`, and anything else stays `network` with the status in the
message. After a run-halting failure (timeout, missing `gh`, no credentials,
network silence) the remaining links are recorded without another call.

Authentication is the operator's. By default the CLI's active account answers.
A user-home `github.accounts` entry names a `gh` login per repository owner;
its token is then obtained with `gh auth token --user` for that run and handed
to the reads as `GH_TOKEN` only. The engine never stores, logs or echoes a
token, never reads `GH_TOKEN` from its own environment, and never runs `gh
auth switch`. `github.enabled: false` records a disabled run; the section is
refused in repository config because repository config cannot authorize
provider communication.

Every observation is a dated row with a closed outcome vocabulary. The store
keeps the latest observation and the latest successful one apart (a failure
never overwrites the last known state), retains five rows per pull request or
checkout plus the newest success, and re-validates rows on read. These tables
live outside the served revision, the export and the replication outbox: a
run never marks the report dirty and the facts never leave the machine.
Interpretation is pure and separate: an open, unapproved, fresh pull request
is an external wait; a merge is stated with its date and does not prove
deployment; a dirty checkout is "N modified, M untracked observed at
<date>; since when is unknown; validation and delivery unobserved"; an
observation older than the freshness window becomes "last observation
<date>; current state unknown"; an unauthenticated read names the exact
action (sign in `gh`, or configure `github.accounts` for the owner).

## Consequences

- The Work view can show, per root, what GitHub and the disk showed at a
  given time beside what the Session declared, with provenance per fact.
- Signing in is an outcome, not a precondition: the source is detected when
  `gh` exists and records `unauthenticated` otherwise, so the gap is visible
  instead of silent.
- Limits accepted in this version: github.com only; the active account unless
  an owner is configured; one REST follow-up per failed read (so a run costs
  at most two spawns per link, two in total when offline); the first dirty
  observation does not date the changes, and a checkout whose `git` exits 128
  for a reason other than "not a repository" is still recorded as
  `not-a-repository` because the reason lives on stderr.
- Rejected alternatives: reading stderr to classify failures (it carries
  tokens and prose and would have to be retained); `gh auth status` as the
  classifier (it also fails offline, so it cannot separate an expired token
  from a lost network); inferring pull requests from checkout branches (it
  would attach the wrong pull request to a Session with certainty).

## Evidence

- `packages/local-machine/src/bounded-process.ts` and its test (runner).
- `packages/local-collectors/src/checkout-status.ts`,
  `packages/local-collectors/src/github-pull-requests.ts` and their tests
  (fake `gh` on PATH, real temporary repositories).
- `packages/usage-store/src/work-fact-store.ts`, the served link reader in
  `served-report-store.ts`, and `docs/local-store-upgrade.md` (additive
  tables under usage version 4).
- `packages/usage-engine-runtime/src/source-adapters.ts` (the two sources,
  the config seam and the injectable inputs) and `packages/report-core/src/work-attention-facts.ts`
  (pure interpretation).
