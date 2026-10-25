# 121 — Delegation independent of the calling harness (read-only reviews)

Status: DONE on branch `feat/delegation-read-only-reviews`, draft PR stacked on PR #67
(`feat/work-resume-cockpit`), 2026-10-25. This file is the execution record.
Authorization: branch, worktree, code and documentation, verification, explicit commits, push of
this branch and one draft PR. No merge, no release, no change to another branch, no real-store
migration, no change to provider sign-ins.

## Base

- foundationSHA: `de3c935c1ae902266ebbaf4f988346393720c014` (head of PR #67, re-read at start; it
  already contains `main` at `62e84b1a`). No extra integration was needed, so featureStartSHA is
  the foundation itself. PR #67 stayed open during the work.
- Decision record: [ADR 0077](../docs/adr/0077-delegation-independent-of-the-calling-harness.md);
  operator guide: [`docs/delegation.md`](../docs/delegation.md).

## Slices

| Slice | Scope | Status |
| --- | --- | --- |
| Contract | `report-core` `delegation-vocabulary.ts` (import-free) and `delegation-contracts.ts` (types) | DONE |
| S1 policy | request/selection parsers and digests, home `delegation` config, rule priority, qualification on a checkout target (generalised `work-routing.ts`), launch decision | DONE |
| S2 store | `delegation_jobs`, `delegation_evaluations`, `delegation_qualifications` (additive, usage v4), atomic idempotency/target/pool/retry-chain checks, guarded transitions, read-only edge reads; result contract, prompt, job view | DONE |
| S3 workers | frozen commit/range scope, checkout facts, one spawn helper, Claude and Codex adapters, shared contract suite; Codex sign-in classified from stderr | DONE |
| S4 engine | five control commands, delegation service (qualify, start, cancel, evaluate, config write, recovery, shutdown), process marker scan | DONE |
| S5 edges | MCP tools (`delegation.*`), engine operations shared by MCP and CLI, read projection, `ai-usage delegation …` | DONE |
| S6 web | 7 oRPC procedures, Manage › Delegation (routes and accounts, rules and simulator, models), Work delegations panel | DONE |
| Review | independent Codex adversarial review: 7 findings confirmed and fixed | DONE |

## Evidence

Simulated (fixtures, fakes, disposable stores): see the PR description for the command list and
counts. Native (real CLIs, isolated AI Usage runtime under the session scratchpad, real sign-ins
untouched): one Claude Code client qualified through MCP, recorded an abstention for Codex (its
weekly window was exhausted, 0 % < 20 % reserve), started a Claude Code worker that returned a
structured review naming both seeded defects in 10 s; a second Claude Code client read the job,
retried the same idempotency key (`reused: true`, no second worker) and recorded a verification.

## Not validated natively

- Codex as executor and Codex as caller: the operator's Codex weekly quota was exhausted at test
  time; the qualification refused the route correctly. Covered by the shared adapter contract suite
  with a fake `codex` only.
- `bun run test:web-production` locally: the machine runs Bun 1.4.2 and the production server
  requires 1.4.3; CI runs it.

## Deferred

Workers that write code, commit or publish; OpenCode and Cursor executors; a specialised external
selector; collection of announced resets and promotions; learning from evaluations; a Codex account
fingerprint (needs `codex app-server` `account/read`).
