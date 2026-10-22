# ADR 0060: Attribute Work responses to their requests

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [0056](0056-native-records-may-settle-a-derived-wait.md)

## Context

A later user message can defer a question or discuss another topic. A child
started after a question can finish independent work. Neither observation
identifies an answer to that question. The chronology rules in ADR 0056 could
therefore incorrectly remove attention.

## Decision

A later message is dated activity, represented as `request-message-observed`.
It keeps the request's attention and marks it for reconsideration. A completed
child establishes related activity, not resolution. An unexpired proposal
remains available until its own native resolution or expiry is observed.

A newer native declaration can replace the earlier declaration; archiving can
remove a session from current attention. Neither operation proves a decision,
authorization or delivery. An exact native response must name the request and,
when several questions exist, only its answered questions. An asynchronous
tool acknowledgement is not such a response. Missing attribution stays unknown.

These are derived, dated interpretations over source facts. They do not rewrite
native status or ask for a second human confirmation of an attributable answer.

## Consequences

Some earlier declarations remain visible after conversation resumes. Their
activity evidence explains why the person should reconsider them. Generic
message-text matching, including treating every “go” as authorization, is
rejected because it loses the request's identity and scope.

## Evidence

[Interpretation regressions](../../packages/report-core/src/work-attention-interpretation.test.ts)
cover deferral, independent completed children, proposals, multiple questions,
and Q1 followed by Q2. [Plan 119](../../plans/119-work-continuity-and-codex-review.md)
records implementation and verification separately.
