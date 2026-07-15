# Plan 016 execution log

- Starting SHA: `6975445`
- Runner consolidation SHA: `fd000b0`
- Final implementation branch: `codex/execute-untracked-plans`

## Protocol parity

| Kind | Request parser | Result parser | Budget |
| --- | --- | --- | --- |
| support | `parseFocusedRevisionRequest` | `parseFocusedReportQueryResult` | served bootstrap |
| overview | `parseFocusedOverviewRequest` | `parseFocusedReportQueryResult` | overview refresh |
| breakdown | `parseFocusedBreakdownRequest` | `parseFocusedReportQueryResult` | breakdown refresh |
| sessions | `parseSessionQueryRequest` | `parseSessionPageResult` | Session query result |
| campaign-children | `parseSessionCampaignChildrenRequest` | `parseSessionCampaignChildrenResult` | Session query result |
| neighbors | `parseSessionNeighborRequest` | `parseSessionNeighborResult` | Session query result |

All kinds now share one lease/path/process/error lifecycle in
`revision-query-runner.server.ts` and one private, read-only SQLite child entry
in `revision-query-runner.ts`. The four legacy runner files were deleted.

Targeted parity: 25 tests passed across runtime-path, focused SQLite, and
Session SQLite/runner tests; the workspace typecheck passed. The 50,000-row
Session SQLite artifact measured `218087424` bytes before and after runner
consolidation (0% change). Schema version is duplicated twice, the writer has a
74-value insert order, and 22 sort fields are audited.

## Optional schema catalog decision

`REJECTED`: extracting the 74-column writer projection and the explicit reader
SQL into a dynamic catalog would reduce two version literals but obscure query
review and produce no artifact-size reduction. The writer and reader stay
separate and explicit; this rejection is permitted by the plan's conditional
acceptance criteria.
