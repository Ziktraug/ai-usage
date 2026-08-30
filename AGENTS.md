# ai-usage — agent and contributor entry point

`ai-usage` turns local AI coding-tool history (Claude Code, Codex, OpenCode,
Cursor) into a usage report: a Bun workspace with a SvelteKit web app, a CLI,
and a background usage engine. It is a local, single-operator product — no
remote service, no provider credentials.

## Read these before changing behavior

- `CONTEXT.md` — the ubiquitous language (harness, collection source, source
  publication, …). Use these words; the "Avoid" lists are binding.
- `docs/architecture.md` — data flow, process ownership, package ownership.
- `docs/adr/README.md` — the decision index. Architecture and product
  invariants live here; check it before re-deciding anything.
- `docs/README.md` — map of the remaining docs (living reference vs dated
  research snapshots).
- `plans/README.md` — the execution backlog and its status table. Plans are
  historical execution records, not current documentation.
- `plans/099-ai-operations-memory-platform-program.md` — the dependency order,
  offline guarantees, and STOP conditions for platform plans 100–110. Read the
  specific child plan in full before executing it.

## The two rules that shape everything

1. **Two planes** (ADR 0009): the durable SQLite database is the data plane;
   authenticated numeric-loopback HTTP is the control plane. Only
   `apps/usage-engine` opens the database read-write. Web and CLI read through
   read-only `query_only` connections. The control plane never carries report
   data.
2. **Contract-first browser boundary** (ADR 0010/0012): browser code imports
   only the oRPC contract, never server modules; TanStack Query owns browser
   server state with one named policy per data identity.

## Commands

- `bun run dev` — supervised engine + web development
- `bun run demo` — isolated synthetic runtime (safe, no local history)
- `bun run build` / `bun run start` — production build and supervised start
- `bun run check` — full verification; `lint`, `typecheck`, `test` also exist
  individually
- `bun x ultracite fix` — format and autofix before committing (Biome)

## Code standards

Biome (via the Ultracite preset, `biome.json`) enforces formatting and most
lint rules mechanically — run `bun x ultracite fix` rather than hand-matching
style. What Biome cannot check, and reviews here care about:

- Svelte 5 runes syntax; `class`/`for` attributes, not `className`/`htmlFor`.
- Effect-based code in packages: typed errors, bounded reads, no silent
  fallbacks. Failures are typed and visible (missing store, expired revision,
  engine down) — never swallowed.
- Explicit types where they clarify seams; `unknown` over `any`; narrow instead
  of asserting.
- Accessibility is a hard gate: axe runs in e2e, keyboard/AT equivalence is an
  accepted decision (ADR 0005/0013).
- Tests accompany behavior changes; browser regressions belong in the single
  Playwright stack (ADR 0006). No `.only`/`.skip` committed.

## Repository conventions

- Never stage with `git add -A`; stage explicit paths (parallel agent sessions
  may share this worktree).
- Do not commit or push unless the operator asks.
- Generated trees (`styled-system/`, `.svelte-kit/`, `.output-build/`,
  `.turbo/`) are disposable — never hand-edit or commit them
  (`docs/generated-tooling-ownership.md`).
- `plans/` is append-only history; update a plan's status row in
  `plans/README.md` when executing one.
- New durable decisions get an ADR (`docs/adr/README.md` describes the
  format); working notes go to `.agent-memory/` (gitignored), not `docs/`.
