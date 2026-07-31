# @ai-usage/report-data

## Owns

Stored-only and pure report assembly: compatibility payloads, publication
captures, project projection, portable snapshot merge/project discovery,
provider-quota history, and bounded exact-revision report/Session queries.

## Does not own

It does not collect local history, schedule sources, mutate config, import
usage, migrate/checkpoint SQLite, publish revisions, create revision artifacts,
lease files, spawn per-query subprocesses, or expose network transport.

## Public interface

- `.`: explicit-config stored report assembly and publication captures.
- `./portable-report`: pure portable snapshot assembly.
- `./provider-quota-history`: bounded read-only quota history.
- `./served-revision-query`: strict bounded revision-keyed query validation and
  execution.

## Dependency rules

It may depend on report-core, Effect values, and
`@ai-usage/usage-store/reader`. It must not import local-machine,
local-collectors, usage-engine-runtime, apps, or `usage-store/writer`.

## Data boundary

Root stored capture/payload/fingerprint workflows require explicit `dbPath`,
config, and machine inputs. Quota-history and served-revision query seams need
their bounded request plus `dbPath`. Queries open the durable database
read-only/query-only and name an immutable served revision. Portable inputs
retain `portable-opaque` authority; only stored locally observed authority may
later permit local detail resolution.

## Test strategy

Use temporary stores produced by usage-store testing/writer fixtures. Prove
result bounds, revision mismatch/expiry behavior, stored/portable parity, and
that reads create or modify no database, WAL, SHM, config, or lease.
