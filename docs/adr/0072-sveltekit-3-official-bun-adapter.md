# ADR 0072: Run SvelteKit 3 on the official `@sveltejs/adapter-bun`

- **Status**: Accepted
- **Date**: 2026-10-22
- **Amends**: [ADR 0011](0011-sveltekit-bun-runtime.md) (supersedes its adapter selection, its
  TypeScript 5.9.3 peer pin and `IDLE_TIMEOUT=45`)

## Context

ADR 0011 chose `svelte-adapter-bun@1.0.1` after `@sveltejs/adapter-node` failed the Bun
lifecycle gates. That package is archived, deprecated and peers `@sveltejs/kit ^2`. SvelteKit 3
removes `svelte.config.js`, `$lib`, `$app/environment` and the separate `goto` focus and scroll
options, and ships an official `@sveltejs/adapter-bun` (1.0.0, Bun >= 1.4) that exempts event
streams from Bun's idle timeout and drains requests on shutdown.

The official adapter does not read `ORIGIN`. Every request is rewritten onto the build-time
`paths.origin`, or else onto `https://<Host>`. This server is plain HTTP on numeric loopback
with a port chosen at start (`PORT`, default 3000; tests use ephemeral ports), and the request
origin is load-bearing: SvelteKit's CSRF self-origin, the trusted-local hook (Origin against
protocol and Host), the RPC CSRF policy (Origin against the request origin when a client sends
no Fetch Metadata) and the server-side subrequest normalisation all read it.

## Decision

- **SvelteKit 3.1.0 with `@sveltejs/adapter-bun@1.0.0`**, configured through
  `sveltekit({...})` in `apps/web/vite.config.ts`; `svelte.config.js` is gone. The phase-isolated
  `outDir` and adapter `out` are unchanged. `version.pollInterval: 0` keeps the app's
  no-polling behaviour (SvelteKit 3 defaults to hourly).
- **The listener origin is bound at start.** `apps/web/sveltekit-loopback-adapter.ts` wraps the
  adapter: after `adapt()` it keeps the generated hand-off module as
  `adapter-bun.generated.js` and fronts it with an `adapter-bun.js` that re-exports it and
  overrides `origin` with `ORIGIN`. Startup fails unless `ORIGIN` is a canonical http(s) origin,
  or that origin with its default port spelled out, and the module exports the canonical form
  (`URL.origin`, which is also how browsers spell `Origin`: `PORT=80` is `http://127.0.0.1`);
  the build fails unless the generated module exports exactly one unconfigured origin
  (`export const origin = undefined;`), so an adapter upgrade that changes this hand-off cannot
  pass silently. `apps/web/start.mjs` stays the only entry and sets `ORIGIN` to the canonical
  origin of `http://127.0.0.1:<PORT>`, as it did for ADR 0011.
- **Origin and CSRF contract.** Request URLs, SvelteKit's CSRF self-origin and the RPC origin
  policy all see `http://127.0.0.1:<PORT>`. SvelteKit rejects form-encoded, `text/plain` and
  content-type-less `POST`/`PUT`/`PATCH`/`DELETE` requests whose `Origin` is absent or differs.
  A tab opened at `http://localhost:<PORT>`, which the trusted-local hook accepts, sends a
  different `Origin`, and SvelteKit 2 checked only form content types, so every browser mutation
  declares a non-form content type: RPC and source-control commands send JSON, uploads JSON or
  CSV, and the bodyless manual export (`POST /api/manual-merge/download`) declares
  `application/json`. Test and benchmark clients that send a bodyless mutation (the
  performance-capture reset) send the listener `Origin`. The trusted-local hook still rejects a
  non-loopback `Host`, cross-site `Sec-Fetch-Site`, a mismatched `Origin` and a mismatched
  `X-Forwarded-Proto` on every request; nothing in it changed.
- **Adapter environment.** `start.mjs` sets `HOST=127.0.0.1`, `PORT`, `BODY_SIZE_LIMIT`,
  `CONNECTION_IDLE_TIMEOUT=45` and `SHUTDOWN_TIMEOUT=2`, and deletes the inherited
  `ADDRESS_HEADER`, `DEVELOPMENT`, `HOST_HEADER`, `IPV6_ONLY`, `PORT_HEADER`, `PROTOCOL_HEADER`,
  `REUSE_PORT`, `SOCKET_PATH` and `XFF_DEPTH`; the production supervisor filters the same keys.
- **SSE and idle connections.** `CONNECTION_IDLE_TIMEOUT` (the adapter caps it at 255 s)
  replaces `IDLE_TIMEOUT` for ordinary keep-alive connections; the adapter calls
  `server.timeout(request, 0)` for `text/event-stream` responses, so source SSE outlives it.
- **Shutdown.** The adapter drains in-flight requests for at most `SHUTDOWN_TIMEOUT` seconds,
  force-closes the rest (aborting their `Request.signal`), then emits `sveltekit:shutdown`; it
  never exits by itself, so `hooks.server.ts` still disposes observability and exits 0. Two
  seconds keeps the whole sequence inside the production supervisor's 5 s grace even when a
  browser holds the source stream open.
- **Navigation.** `noScroll` plus `keepFocus` becomes `reset: false` (links:
  `data-sveltekit-reset="false"`). SvelteKit 3 has no equivalent of `noScroll` alone (keep the
  scroll position, still reset focus): those navigations keep SvelteKit's focus reset and the
  shell calls `disableScrollHandling()` from `onNavigate` for them, marked by a shell `goto`
  with `preserveScroll` or by `data-ai-usage-preserve-scroll` on a link. That request is keyed
  to its target URL: SvelteKit skips `beforeNavigate` for a navigation that starts while another
  is in flight but still runs `onNavigate` for it, so a bare flag would leak into it, and the
  decision is made in `onNavigate` (from the click target or the still-pending shell `goto`
  intent) so a superseding navigation that asks to keep the scroll position keeps it. Back and
  Forward reset focus after every traversal, as in SvelteKit 2: SvelteKit 3 resets only across
  entries with different reset indexes, which left focus on the departed page's control after
  Back across a `reset: false` entry. The shell blurs before the traversal renders and resets
  the focus starting point afterwards unless a component claimed focus. Current-entry
  annotations (history keys, the session window anchor, the Skills fallback URL) keep the
  deprecated `replaceState`, because `goto(url, { shallow: true })` runs every navigation hook,
  can be cancelled by the dirty-editor guard and takes over the in-flight navigation. SvelteKit
  3 applies `replaceState` asynchronously, so the shell routes those annotations through one
  page-state writer that composes on the latest requested state, and a rejected write reaches a
  visible failure status. SvelteKit 3 also hands each written state back as a new object while
  `page.url` stays put, so the Skills fallback writes only while the address is not already the
  worktable and never twice at once; re-running on every new `page.state` looped.
- **Imports and types.** `$lib` becomes `#lib` (`imports` in `apps/web/package.json`, real file
  extensions); `$app/environment` becomes `$app/env`; `Handle`/`HandleFetch` come from
  `@sveltejs/kit/hooks`. `apps/web/tsconfig.json` extends `$app/tsconfig` and pins `rootDirs` to
  `.svelte-kit/check/types`: SvelteKit writes that parent config once into
  `apps/web/node_modules/$app/` for every phase, so without the pin type-checking would follow
  whichever of dev, check or build synced last.

## Consequences

- The hand-off module and its `origin` export are an adapter-internal contract. The adapter is
  pinned exactly; an upgrade that changes the module fails `bun run build` with a named error.
- The adapter externalises the Web package's production `dependencies` from the server bundle;
  the built server resolves them from the checkout's `node_modules`, where `start.mjs` already
  runs it.
- Production builds check `/_app/version.json` when the tab regains focus or becomes visible
  (SvelteKit 3, not configurable); there is still no timed polling.
- A click on a link to the current URL is a `refreshAll()` navigation. The mounted report, its
  scroll position and the history survive it (`e2e/svelte-shell.spec.ts`).
- Trailing-slash redirects carry a relative `Location` (`/sources/` → `../sources`).
- The report's initial client closure grew from 298,131 to 302,512 bytes gzip, inside the
  recorded 301,473-byte measurement's 2 % tolerance and the 305,000-byte ceiling.

## Rejected alternatives

- **`paths.origin`.** It is a build-time constant; the listener port is chosen at start.
- **`PROTOCOL_HEADER`.** It names a request header. Browsers send none that carries the scheme,
  and a client-chosen header is not a trust input for a loopback server.
- **The adapter default `https://<Host>`.** A same-origin browser `Origin` is `http://…`: on the
  committed fixture artifact SvelteKit answered a same-origin plain-text `POST` with
  `403 Cross-site POST form submissions are forbidden`, and the trusted-local hook and the RPC
  origin policy would reject legitimate requests.
- **`csrf.trustedOrigins: ['*']`.** It switches SvelteKit's CSRF layer off.
- **Wrapping `Bun.serve` in `start.mjs`** to inject a trusted protocol header: it patches a
  runtime global the adapter calls internally, which is a wider and less visible coupling than
  the one exported hand-off value.

## Evidence

Gathered on 2026-10-22 in the `chore/upgrade-dependencies` worktree under `nix develop`
(Bun 1.4.3, x86_64-linux); logs under the session scratchpad `logs/batch3-*.log`.

- `bun install --frozen-lockfile --ignore-scripts` → `Checked 520 installs across 587 packages
  (no changes)`, exit 0. `bun run verify` → exit 0: Ultracite checked 1,514 files,
  `svelte-check` 0 errors and 0 warnings, 3,861 tests pass and 0 fail (the 14 more than before
  the upgrade are the new adapter, navigation-mapping, navigation-owner and page-state-writer
  tests in `@ai-usage/web`), production build green.
- `bun test tools/check-sveltekit-runtime-lifecycle.test.ts` → 3 pass: the fixture, rebuilt on
  the official adapter from its own frozen lock, served SSR and a static asset, held SSE for more
  than 30 s with `CONNECTION_IDLE_TIMEOUT=45`, exited 0 on `SIGTERM`, released its port and left
  its artifact byte-identical.
- `bun run test:web-production` → exit 0, now also proving the origin contract: a same-origin
  JSON command without Fetch Metadata succeeds, a same-origin `text/plain` `POST` passes
  SvelteKit's CSRF check and reaches the route (415), and the same `POST` with a cross-site or
  missing `Origin` gets SvelteKit's 403.
- Probes on the official adapter without the binding: a same-origin `http` plain-text `POST`
  got `403 Cross-site POST form submissions are forbidden`; an event stream's `Request.signal`
  fired `abort` and the stream was cancelled when the client dropped, through the adapter's
  request rewrite; with `SHUTDOWN_TIMEOUT=2` and a stream held open, `SIGTERM` exited 0 after
  2.0 s.
- `bun run test:web-dev-build-isolation` → exit 0 in 6 of 7 runs; the first run after the
  upgrade failed without a printed cause and did not reproduce (cold Vite cache included).
  `svelte-check` passes after a production build left the shared `$app/tsconfig` pointing at
  `.svelte-kit/build/types`, because `apps/web/tsconfig.json` resolves to the check phase.
- `bun run test:setup-loopback`, `bun run test:web-client-manifest …` and
  `bun run test:web-bundle` → exit 0 each.
- Browser suites, serialised on a shared lock: `test:e2e` 235 passed (through
  `tools/retry-on-dev-server-hang.ts`, no retry), `test:e2e-demo` 2 passed,
  `test:e2e-production` 13 + 7 + 31 passed, the production Memory suite 3 passed.
- Three isolated `bun run dev` cold starts reached Vite ready in 4.6–5.8 s, served `/` with 200,
  and left no process with their `HOME` after `SIGINT` to the process group.
- Review fixes (logs `logs/kitfix-*.log`). `/skills/global/<missing>` looped on `replaceState`
  until the page hung (`e2e/skills.spec.ts` failed against the old effect) and now writes the
  worktable URL once. `e2e/history-focus.spec.ts` passed 6 of 6 against the SvelteKit 2 build of
  the base commit, failed 3 of 6 on SvelteKit 3 without the shell's traversal reset (focus stayed
  on the campaign card, the Analysis tab and the Memory filter button after Back) and passes 6
  of 6 with it. `e2e/production-localhost-mutation.scale.ts` sees SvelteKit answer a bodyless
  `POST` from `Origin: http://localhost:<PORT>` with its form CSRF 403, and the browser export
  from a `localhost` tab succeed. `benchmark:session-scroll` 4 passed and the plan 072 benchmark
  43 passed with the perf reset sending the listener `Origin`.
- Round-2 review fixes (logs `logs/r2fix-*.log`). A link or shell `goto` that asks to keep the
  scroll position and starts while another navigation is in flight gets no `beforeNavigate`, so
  `onNavigate` also reads its own click and its still-pending `goto` intent (without consuming
  it); a superseding navigation that does not ask still gets SvelteKit's scroll handling. The new
  `e2e/svelte-shell.spec.ts` case (a Memory view link clicked while a Sync navigation's data is
  held) ended at `scrollY` 0 instead of 700 without that reading and passed 3 of 3 with it;
  `test:e2e` 246 passed. A rejected Skills fallback rewrite now shows "Navigation failed. Try
  again." instead of the framework's error text, and clears once a later rewrite is accepted or
  the address names no missing skill.
