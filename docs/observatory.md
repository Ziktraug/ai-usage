# Observatory

`/observatory` follows observed tokens across the current report selection. It is
an additional reader of the served revision, not a collector or a second store.
The diagram joins projects, observed model segments and four disjoint token
categories: fresh input, cache read, cache written and output. It does not infer
billed cost, quality or present agent activity.

The page uses the existing exact-revision `report.focusedBreakdown` contract with
`includeObservatory: true`. Its fingerprint differs from the ordinary Breakdown
request. Requests without that option retain their previous response and query
cost. The SQL projection groups canonical `session_rows` joined to
`session_model_segments`; it never aggregates already-rolled-up campaign rows.
The portable projection follows the same model attribution rules.

The eight largest projects and twelve largest models retain their names.
Overflow identities use `null`, distinct from any real name, and stay in the
flow's totals. The result carries at most 117 project/model links. Every diagram
column uses the same scale and its exact values are available in a keyboard
scrollable table. Period, search and inherited report filters remain in the URL.
Incomplete session usage and upstream report warnings remain visible. A missing
or expired revision reports an error rather than falling back to newer data.

The route is loaded separately from the report's initial bundle. It uses the
existing design tokens and query cache policies. The synthetic mode uses only
repository fixtures; tests do not open native histories or daily databases.
