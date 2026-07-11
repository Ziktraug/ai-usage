# @ai-usage/sync

Legacy snapshot sync package.

This package owns the existing CLI snapshot-sync command surface: snapshot HTTP transport, discovery, remote registration, and pull/watch workflows. The web `/sync` route uses explicit file import/export through `@ai-usage/usage-merge` and `@ai-usage/usage-store`; it does not depend on this package.

Do not add new web or report-data dependencies on this package.
