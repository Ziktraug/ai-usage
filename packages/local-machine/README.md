# @ai-usage/local-machine

## Owns

Collector-independent access to this machine: hardened bounded/no-follow file
reads, exact on-demand Claude/Codex/OpenCode Session analysis, shared pure
harness facts, platform paths, local Git/text/label helpers, machine/config
transactions, private-file primitives, and deterministic test homes.

## Does not own

It does not collect reports, maintain collector caches, normalize complete
usage datasets, schedule work, open the usage database, publish revisions,
expose HTTP, or render output.

## Public interface

Use the declared focused subpaths in `package.json`. There is no broad root
facade. `./internal/codex-history` is shared only by the exact Codex reader and
the collector-side cache adapter; application code must not import it.

`./skills-config` is deliberately field-scoped: reading exposes only the
`skills` field and updating it preserves every unrelated config field.

## Dependency rules

This package may depend on pure report-core contracts, Skills config contracts,
and Effect primitives. It must not import local-collectors, report-data,
usage-store, usage-engine packages, or apps.

Web production use is restricted exactly to
`@ai-usage/local-machine/session-detail` and
`@ai-usage/local-machine/skills-config`. Collection paths belong to
usage-engine-runtime through local-collectors.

## Data boundary

Exact Session readers re-open only the requested local source after a caller
has established authority. They use explicit byte/file/depth budgets, regular
file and symlink checks, strict decoding, and immutable fixture expectations.
They never consult or update collector caches.

Shared config writes use one serialized transaction and owner-only atomic file
replacement. Packages that call these primitives still own authorization and
domain semantics; the usage engine owns usage-domain mutations, while Web owns
only the unrelated Skills field.

## Test strategy

Use isolated `plan052-*` temporary homes and snapshot every fixture path,
size, and digest before/after positive reads. Exact-reader tests must prove no
file, cache, database, or config creation or mutation.
