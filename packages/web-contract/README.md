# Web contract

This package is the pure, contract-first browser/server boundary for the Web
application. It may depend only on `@orpc/contract`, Valibot, and explicitly
reviewed pure domain contract packages.

The root entrypoint is intentionally composition-only. Family procedures use
direct leaf imports and are composed only at the reviewed V5 convergence
checkpoint; no barrel may expose server implementations.

Browser closures may import public contracts, schemas, errors, and the browser
client adapter. They may not reach `@orpc/server`, SvelteKit server modules,
Node, Bun, usage-store, report-data, local-machine, engine implementations,
`$lib/server`, or `*.server.*` modules.

V0 owns public errors, schema conventions, and request-policy metadata. V1-V4
own disjoint procedure families. V5 owns the final contract/router composition.
F0 deliberately defines no placeholder procedure or wire shape.
