# ADR 0062: Run owned Codex reviews through the subscription app-server

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [0053](0053-first-read-only-review-attempt-launched-by-the-engine.md), [0055](0055-review-attempt-reservation-scope-and-harness-guarantee.md)
- **Extends:** [0057](0057-observed-account-identity-and-on-demand-routing-qualification.md)

## Context

Work already qualifies Codex routes but its review executor was Claude-only.
The installed Codex app-server supplies subscription account and quota metadata,
native thread/turn identities, streamed output and interruption on one owned
stdio connection. A recommendation alone cannot guarantee that launch uses
the same account, model or included capacity.

## Decision

The engine uses the shared bounded app-server client for Codex. Authentication
stays with the CLI; account identity is hashed, credentials are not read or
copied, and API keys are excluded from the child environment. Launch requires
the qualified ChatGPT account, explicit selected model and observed applicable
capacity. Models of one account do not create independent quota reservoirs.

The existing fixed-commit scope preparation is reused. The bounded patch goes
through the protocol, never process arguments. Per-process reductions disable
external capabilities; effective configuration, returned model/effort,
read-only sandbox, no network, approval policy and empty MCP inventory are
checked before generation. Managed policy remains authoritative. Runtime tool
requests are refused, and unexpected tool use or model rerouting interrupts the
owned turn. This is a qualified harness policy, not a claim of OS containment.

The no-credit contract fails closed when credits are enabled or unknown.
Installed CLI 0.163.0 exposes no qualified per-turn prohibition on credit use;
current included capacity alone cannot establish that prohibition. The adapter
does not change account settings, activate resets, retry with another account
or fall back to an API. A live block remains a visible failed qualification.

The existing durable reservation covers both harnesses. Native thread and turn
IDs are stored separately. Stop requested and native interruption confirmed are
separate timestamps. Partial output survives failure or lost contact. An absent
Claude process marker cannot release a Codex reservation. Restart never adopts
or signals a session the engine does not own. Native turn interruption does not
prove every terminal or descendant has ended.

## Consequences

Codex review is executable only after all launch checks succeed. Metadata-only
qualification and a fake app-server lifecycle are not a live review. The campaign
account currently cannot satisfy the no-credit contract, so its generation
remains blocked while the other product paths can be verified.

A separate transport for review was rejected because quota and launch must use
the same account semantics. Releasing lost reservations by time or pid alone
was rejected because neither proves that execution ended.

## Evidence

[Codex adapter](../../packages/local-collectors/src/codex-review-launcher.ts),
[stdio client](../../packages/local-collectors/src/codex-app-server-client.ts),
[engine lifecycle](../../packages/usage-engine-runtime/src/review-attempts.ts)
and their focused tests. [Plan 122](../../plans/122-work-continuity-and-codex-review.md)
records the exact distinction between synthetic and native evidence.
