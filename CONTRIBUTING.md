# Contributing

Thank you for improving ai-usage. Please open an issue before a large product or architecture change so its scope can be agreed first.

## Local development

Install [Bun](https://bun.sh/), then run:

```sh
bun install
bun run demo
```

`bun run demo` is the safe way to explore the frontend: it binds to loopback and uses only committed synthetic data. `bun run dev` reads this machine's real local usage history, so use it only when that is intentional.

## Changes

- Keep collectors, report-domain code, persistence, and UI inside the package boundaries described in [docs/architecture.md](docs/architecture.md).
- Use deterministic synthetic fixtures in tests, screenshots, and bug reports. Never contribute histories, prompts, credentials, local configuration, or usage databases.
- Add focused regression coverage and preserve accessibility, cancellation, exact-revision, and loopback-only behavior.
- Run `bun run fix`, then the relevant tests. Before submitting a broad change, run `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`.

Keep commits focused and explain user-visible behavior and trade-offs in the pull request.
