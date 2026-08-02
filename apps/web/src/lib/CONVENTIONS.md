# Svelte migration composition conventions

Browser modules import only public contracts, schemas, public errors, and the
browser client adapter. Server routers and deep runtime implementations are
never reachable from browser closures.

Server-only code lives under `lib/server` or an explicit `*.server.*` leaf.
Feature and transport modules use direct leaf imports; no feature barrel is added.

Route files stay thin and compose feature owners without acquiring real state.
The shadow route root remains synthetic-only until the reviewed X1 cutover.

Framework-neutral seams are intentionally structural:

- `foundation/navigation` owns search intent vocabulary; R0 owns adapters.
- `foundation/table` owns updater and table-state shapes; P3 owns the Svelte table.
- `foundation/subscription.ts` promises no eager first emission.

V0-V5 own RPC policy, leaves, clients, routers, and composition. Q0-Q3 own
request-scoped query clients and policies. D0-D4 own design-system convergence.
Generated SvelteKit output is disposable and follows
`docs/generated-tooling-ownership.md`.
