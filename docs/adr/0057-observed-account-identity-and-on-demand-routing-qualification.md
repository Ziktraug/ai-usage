# ADR 0057: Observed account identity, models of one account, and on-demand routing qualification

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0009, 0052, 0053

## Context

ADR 0052 lets the one declaration for a harness family and machine bind the
bare quota stream (`claude`, no account suffix). That binding is a
declaration, not proof: nothing showed that the account the CLI is signed in
to is the account the operator declared, and a later change of account
passed unnoticed. One declaration also carried one model, so two models of
one account (a Fable limit exhausted, Opus still allowed) could only be
written as two accounts. And the Work view qualified routing in the browser
from a cached context, while the launch re-decided in the engine.

## Decision

- **Identity signal.** The `executors.capabilities` collector keeps, for a
  signed-in Claude Code, the first 16 hexadecimal characters of a
  domain-separated SHA-256 of the `orgId` and lowercased `email` that
  `claude auth status` already prints (`accountFingerprint`, an additive
  column). The identifiers themselves are never stored; credential files
  are never read. Codex exposes its account only in its credential file, so
  it has no fingerprint.
- **Pin.** `routing.executors[].accountFingerprint` (optional) is the
  operator's persisted statement of which account the route belongs to. A
  declared value is never shown as observed: the candidate carries
  `identity.declared` and `identity.observed` with its own provenance.
- **Rule.** `confirmed` (pin equals a current observation) qualifies;
  `contradicted` excludes the route until the operator signs back in or
  re-declares; `unpinned` (the CLI reports an account, the entry pins none)
  is `conditional` on the pin; `unobserved` (pinned, no current
  observation) is `conditional` on that observation; `not-observable`
  (neither side) keeps the ADR 0052 single-declaration binding and says so.
  Among several entries sharing the bare stream, the one whose pin the
  signed-in account confirms binds it.
- **Models of one account.** `routing.executors[].alternateModels` declares
  further models after `model`, in preference order. Each yields a
  candidate sharing one `resourceId` and the same quota reading: one
  resource, never extra reserves. A window blocked for one model excludes
  only the models it names; a provider read `partial` because a window is
  blocked is judged window by window.
- **On-demand qualification.** The engine command `qualify-review-routing`
  runs the `executors.capabilities` source, re-reads the declarations and
  the stored quota, and answers the launch policy's decision: the
  recommendation, each candidate's exclusions, limits, actions and identity,
  and whether the executor observation was refreshed. It is a bounded
  decision (48 KiB), not report data; it starts and grants nothing.

## Consequences

- An existing unpinned Claude declaration on a machine whose CLI prints an
  account becomes `conditional` until the operator adds the fingerprint the
  Work view shows; a launch is refused meanwhile. That is the requalification.
- The engine's launch refusal and the page agree, since both use
  `qualifyReviewCandidates` on the same stored facts.

## Limits

- The fingerprint proves the CLI's signed-in account, not billing; the
  subscription stays the operator's declaration (ADR 0052).
- It is a local comparison key, not an anonymization: anyone who knows the
  email and organization can recompute it. Like every executor observation it
  never enters a served revision, snapshot or replication.
- The probe runs with the bounded runner's allow-listed environment; a
  `CLAUDE_CONFIG_DIR` or API key exported only in another shell is not seen.
- The quota reading carries no account: a stored reading taken before an
  account change is attributed to the account now signed in until the next
  quota refresh (15-minute freshness bound).

## Rejected alternatives

- Reading `~/.claude.json` `oauthAccount` or the Codex `auth.json` claims:
  the CLI's own status command already reports the account, and a
  credential file is never an acceptable input.

## Evidence

- `packages/local-collectors/src/executor-observations.ts` (`claudeAccountFingerprint`),
  `packages/report-core/src/work-routing.ts` (identity, `declarationForReviewCandidate`,
  `qualifyReviewRouting`, `buildRoutingQualification`) with `work-routing.test.ts`.
- `packages/usage-engine-runtime/src/routing-qualification.ts`,
  `packages/usage-engine-control/src/contracts.ts` (`qualify-review-routing`),
  `apps/web/src/lib/features/work/work-routing.svelte`.
- `plans/118-work-resume-cockpit.md`, lot M record.
