# ADR 0011: Run SvelteKit with svelte-adapter-bun

- **Status**: Superseded 2026-10-24 by
  [ADR 0072](0072-sveltekit-3-official-bun-adapter.md). Its adapter, pins and
  idle timeout were already replaced there, and 0072's Decision restates the
  lifecycle requirements it kept (numeric loopback and the adapter
  environment, SSE outliving the idle timeout, `Request.signal` aborts and the
  exit after `sveltekit:shutdown`, phase-isolated outputs), while its Evidence
  carries the committed lifecycle fixture. ADR 0070's extension of this record
  applies to ADR 0072.
- **Superseded by**: [ADR 0072](0072-sveltekit-3-official-bun-adapter.md)
- **Date**: 2026-08-09
- **Amended by**: [ADR 0072](0072-sveltekit-3-official-bun-adapter.md)

> Amended 2026-10-22 (SvelteKit 3): the adapter selection is superseded by
> ADR 0072. Web runs SvelteKit 3.1.0 on the official `@sveltejs/adapter-bun`
> 1.0.0, so the TypeScript 5.9.3 peer pin and `IDLE_TIMEOUT=45` no longer
> apply; production sets `CONNECTION_IDLE_TIMEOUT=45` and the adapter exempts
> event streams from it. The lifecycle requirements below (numeric loopback,
> SSE beyond 30 seconds, `Request.signal` cancellation, exit after
> `sveltekit:shutdown`, isolated outputs) and the committed fixture stay.

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

The selected `svelte-adapter-bun@1.0.1` package declares TypeScript `^5` as a
peer. The Web SvelteKit ecosystem is therefore pinned to `typescript@5.9.3`,
which passed the isolated fixture install, Svelte check and production build.
The repository's root tools may remain on TypeScript 6 because that toolchain is
not the adapter's application peer environment.
The regression fixture separately pins `@types/node@25.9.3` as test-only
tooling; it is not an application ecosystem decision.

## Decision

Use the exact ecosystem pins declared by the Web workspace manifests and lockfile,
and select `svelte-adapter-bun@1.0.1`.

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

## Committed regression evidence

The committed fixture is a minimal, exact-pinned SvelteKit application using the
selected adapter. Its test copies the source and lock into a private temporary
workspace, installs with `--frozen-lockfile`, runs Svelte check, builds the
production artifact and then starts that artifact on numeric loopback.

The reusable lifecycle checker verifies meaningful SSR, a static asset and
greater-than-30-second SSE before signaling shutdown. It reaps only its acquired
process group, proves port release and verifies the artifact's file identities,
metadata and SHA-256 content hashes are unchanged. Focused tests cover
equal-size artifact rewrites and temporary-root cleanup after partial setup
failure. Dependencies, generated output and build products are not retained.

## Disposable empirical matrix

The deleted disposable application separately established request-scoped
context isolation, exact oRPC success and closed errors, Svelte Query SSR
hydration without duplicate acquisition, Ark UI/Panda rendering, native abort
propagation, 31.1-second SSE, signal shutdown, no descendants, isolated
dev/build outputs and the repository production supervisor interface.

Direct, indirect, re-exported and dynamic browser imports of
`$lib/server/router` each failed SvelteKit's browser guard. These broader
matrix results inform the decision but are not represented as committed
end-to-end regression coverage by the minimal lifecycle fixture.

This replaces the default adapter preference only because adapter-node failed
mandatory Bun lifecycle behavior. Nitro is not retained beneath SvelteKit.
