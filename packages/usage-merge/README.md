# @ai-usage/usage-merge

Owns manual usage-merge parsing, digest binding, preview, confirmation, warning
projection, and storage-error mapping. Application and engine adapters own file
discovery, bounded reads, inbox cleanup, command transport, and scheduling.

The package depends only on report-core merge contracts, the usage-store writer
facade, and Effect. It must not import collectors, report-data, engine runtime,
or application packages.
