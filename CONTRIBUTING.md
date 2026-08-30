# Contributing

Thank you for improving ai-usage. Please open an issue before a large product or architecture change so its scope can be agreed first.

## Local development

Install [Bun](https://bun.sh/), then run:

```sh
bun install
bun run demo
```

`bun run demo` starts an isolated development runtime backed by committed synthetic data. It binds to loopback and does not read local histories or enable mutations. Use `bun run dev` only when reading this machine's configured local data is intentional.

`bun run dev` supervises the persistent usage engine and Web as separate tasks.
Use the repository-root `bun run dev:once`, or `bun run start:web-only` after a
completed production build, only for explicit Web-only diagnostics against an
existing compatible store. Production builds use `.output-build/sveltekit`,
development uses the phase-isolated `.svelte-kit/dev` tree, and a production
build must never clean active development output.

The usage engine is the sole production writer. Web and CLI report code must
open SQLite only through `@ai-usage/usage-store/reader`; fresh or usage-domain
mutating work must use control contracts and run through the engine (HTTP daemon
or bounded `once`). Do not add a report data endpoint, dual-write fallback,
copied revision database, query lease, per-query child process, or write-capable
app connection.

## Changes

- Keep collectors, report-domain code, persistence, and UI inside the package boundaries described in [docs/architecture.md](docs/architecture.md).
- Use deterministic synthetic fixtures in tests, screenshots, and bug reports. Never contribute histories, prompts, credentials, local configuration, or usage databases.
- Give every runtime/performance test an isolated temporary home, database,
  engine state/rendezvous/inbox, log directory, port, and fixture. Never inspect
  or mutate a maintainer's existing ai-usage state.
- Add focused regression coverage and preserve accessibility, cancellation, exact-revision, and loopback-only behavior.
- Run `bun run fix`, then the relevant tests. Before submitting a broad change,
  run `bun run verify`; browser behavior changes must also run the relevant E2E
  gate.

For a file-level SQLite backup, stop the usage engine cleanly first. Do not copy
the main database alone while WAL may be active, and do not treat writer locks,
rendezvous, inbox files, logs, WAL, SHM, or other runtime state as backup
payload after a clean quiesced stop. Config and machine files are separate from
the usage database and must be backed up separately when desired.

Keep commits focused and explain user-visible behavior and trade-offs in the pull request.
