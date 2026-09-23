# ai-usage — agent and contributor entry point

`ai-usage` turns local AI coding-tool history (Claude Code, Codex, OpenCode,
Cursor) into a usage report: a Bun workspace with a SvelteKit web app, a CLI,
and a background usage engine. It is local-first: the default composition is
single-operator with no remote service and no provider credentials; the
connected platform (`apps/server`, PostgreSQL 17, GitHub login, outbound Device
replication) is an explicit opt-in that local mode never contacts.

## Read the references relevant to the change

Use the nearest instructions and relevant source files. Do not read the entire
project documentation for a small edit or repeat context already available.

- Domain terms and product behavior: use `CONTEXT.md`; its vocabulary and
  "Avoid" lists remain binding.
- Data flow, package boundaries, or process ownership: use
  `docs/architecture.md` and relevant accepted decisions in `docs/adr/README.md`.
- Opening real local stores from another code version, schema changes, or store
  upgrades: read `docs/local-store-upgrade.md` before touching those stores.
  Backup and compatibility requirements still apply; there is no downgrade path.
- Finding other documentation: consult `docs/README.md` as needed.
- Executing or resuming a plan: consult `plans/README.md`, the target plan,
  and its handoff. Plans are historical execution records, not current docs.
- Executing platform plans 100–110: first read
  `plans/099-ai-operations-memory-platform-program.md` and the specific child
  plan for dependencies, offline guarantees, and STOP conditions.

## Completion and verification

Complete the requested behavior and affected verification before handing back.
Run the checks that cover the change; rerun them after relevant corrections.
Use the broader `verify` gate when the scope or acceptance criteria requires it,
not after every intermediate file edit. Documentation-only changes need reference
and diff checks. Do not claim live-store safety from disposable-fixture tests.

Routine local edits and isolated tests within the authorized task do not need
repeated permission. Preserve explicit boundaries for real stores, publications,
and external systems; reuse authorization already granted for the current scope.

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
- `bun run check` — fast Ultracite formatting and static checks
- `bun run verify` — broad repository gate: check, lint, typecheck, tests, build
- `bun run lint` / `bun run typecheck` / `bun run test` — individual gates
- `bun run test:e2e` — browser regressions (run the relevant E2E variant)
- `bun run test:postgres` — PostgreSQL 17 suites; needs `nix develop` (CI runs
  them flake-locked). Not part of `verify`.
- `bun run test:local-platform` — proves local mode never consults the
  PostgreSQL or authentication factories. CI-only, not part of `verify`.
- `bun run dev:platform` — disposable PostgreSQL + connected server
  (`docs/platform-server-operations.md`); `dev` stays PostgreSQL-free
- `bun run mcp` / `bun run mcp:register:codex` — local stdio Memory MCP server
  and its Codex registration
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
