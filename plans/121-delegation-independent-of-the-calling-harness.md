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

## Follow-up, 2026-10-25 morning (after the Codex weekly reset)

Both gaps above are closed; same isolated runtime, real sign-ins untouched, `codex-cli 0.164.0`,
`Claude Code 2.1.310`, Bun 1.4.3 from the Nix store for the production smoke.

- Requalification: both routes admissible (the Codex weekly window had reset).
- Claude Code client → Codex worker: qualified, chose the Codex route, started it; the real
  `codex exec` worker (read-only sandbox, no MCP, no web search) returned a structured review in
  20 s naming both seeded defects with line evidence (`retry.ts:11`, `retry.ts:16`), usage reported
  by the harness, resolved model `unknown` (exec does not report it), checkout left clean.
- Codex client → Claude Code worker: `codex exec` qualified through MCP, then `delegation.start`
  was refused by Codex itself ("MCP tool call requires approval, but approval policy is never")
  because the tool is annotated open-world. With
  `mcp_servers.<name>.tools."delegation.start".approval_mode = "approve"` (inline-table form for
  `-c`; a dotted `-c` path does not keep the dot of the tool name) the client started the Claude
  Code worker, which returned a structured review in 10 s. The annotation stays honest; the
  approval is documented in `docs/delegation.md`.
- Cross-harness follow-up: a Codex client read the job a Claude Code client had started, checked
  the findings against the file in its own read-only sandbox, and recorded a `calling-model`
  verification.
- `bun run test:web-production` with Bun 1.4.3: pass (routes healthy, trusted-local only, IPv4
  loopback, port collisions fail cleanly).
