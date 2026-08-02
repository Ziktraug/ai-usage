# ADR 0011: Run SvelteKit with svelte-adapter-bun

Status: Accepted

## Context

Plan 068 requires SvelteKit SSR, oRPC, Svelte Query hydration, Ark UI, Panda,
long-lived SSE, request cancellation, isolated build outputs and production
supervisor compatibility under Bun.

The disposable matrix tested `@sveltejs/adapter-node@5.5.7` first. Its HTTP
request body required explicit reconstruction before oRPC would respond under
Bun. More importantly, response-side disconnect did not reach
`Request.signal`, and its generated signal handler did not terminate the Bun
process after the configured shutdown deadline. The official adapter therefore
failed mandatory lifecycle gates.

`svelte-adapter-bun@1.0.1` passed SSR/assets, isolated concurrent request
context, exact oRPC success and closed errors, Svelte Query SSR hydration without
a duplicate acquisition, Ark UI/Panda rendering, native abort propagation,
31.1-second SSE, signal shutdown, process/port exit, isolated dev/build outputs
and the repository production supervisor interface.

## Decision

Use the exact ecosystem pins exported by
`tools/sveltekit-runtime-decision.ts` and select
`svelte-adapter-bun@1.0.1`.

Production must:

- bind `HOST=127.0.0.1` to an ephemeral test port or the configured local port;
- launch Bun with `--no-env-file --no-install`;
- set `IDLE_TIMEOUT=45` so source SSE can remain open beyond 30 seconds;
- use distinct SvelteKit intermediate and adapter output directories for
  concurrent dev/build operations;
- use the adapter-native `Request.signal` for cancellation and buffer the
  already-received oRPC body when constructing the handler request;
- exit after the adapter's `sveltekit:shutdown` event because version 1.0.1
  stops its server but otherwise leaves the Bun process alive;
- reuse process identity and liveness helpers from
  `@ai-usage/usage-engine-control/node`.

## Evidence and consequences

The reusable lifecycle checker starts a detached production fixture on numeric
loopback, verifies SSR/static assets and greater-than-30-second SSE, signals
shutdown, reaps the exact process group and proves process/port release. Direct,
indirect, re-exported and dynamic browser imports of `$lib/server/router`
individually failed SvelteKit's browser guard. A production build into isolated
intermediate/final roots completed while the dev server remained healthy, and
the built artifact exited cleanly through `spawnProductionChild`.

This replaces the default adapter preference only because adapter-node failed
mandatory Bun lifecycle behavior. Nitro is not retained beneath SvelteKit.
