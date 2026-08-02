# apps/cli

## Owns

Arguments, terminal/CSV/JSON/payload rendering, bounded portable snapshot
files, setup UI, quota/import/merge commands, cancellation, exit codes, and
file-only CLI diagnostics.

## Does not own

It does not collect in process, implement source adapters, mutate config/store
directly, migrate/checkpoint SQLite, compose engine-runtime, or expose shared
data to other apps.

## Data and control boundaries

`--stored` and other compatible published reads open the existing database
through `usage-store/reader` and require no engine. Fresh reports and every
usage-domain mutation use a compatible daemon through
`usage-engine-control`; if none exists, CLI launches one bounded foreground
usage-engine `once` process, waits for its terminal result, reads the committed
revision, and reaps it. A live protocol/target mismatch never falls back to a
second writer.

Explicit portable output remains a CLI file write after a read. Snapshot inputs
and operator files are bounded, explicit, regular/no-follow paths, and the
engine revalidates mutating inputs. Engine diagnostics stay off structured
stdout and preserve warning order and exit-code contracts.

## Dependency rules

CLI may use effect-runtime, report-core,
`@ai-usage/report-data/portable-report`, usage-engine-control,
`usage-store/reader`, and the engine executable entrypoint as a terminal child
process. It must not import local-machine, local-collectors,
usage-engine-runtime, or `usage-store/writer` directly or transitively.

## Test strategy

Cover stored reads with engine down, daemon/foreground parity and concurrency,
empty/incompatible store, stale rendezvous, protocol mismatch, Ctrl-C and
forced child reap, quota/import/merge, large diagnostic drains, and byte-exact
supported outputs using isolated homes/stores/state/logs/ports.
