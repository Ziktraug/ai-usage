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

The constellation shows at most 900 matching canonical sessions, sorted by
recorded tokens. Its count distinguishes displayed nodes from the full selection;
limiting the map never limits the Sankey totals. Project proximity is illustrative.
Parent edges require the exact declared native parent identity in the same
machine and harness. Missing, ambiguous and cyclic edges stay unresolved. The
2D and perspective 3D views share positions, support zoom and manual rotation,
and provide an equivalent session selector and native detail links. No automatic
motion or claim about currently active agents is made.

Campaigns also offers an optional replay of its served campaign map. Playback is
paused initially, including for reduced-motion preferences. The cursor measures
elapsed wall time; recorded session spans include idle gaps. At most 120 loaded
members are displayed, with omitted counts retained. Only declared map parents
are shown. Missing endpoints never become an invented interval.

Selecting a member reads native detail through the existing exact-revision
Session Query policy. The canonical rounds derivation and observed prompt and
interaction timestamps feed the latest 80 events at or before the cursor.
Coverage, truncation, report/native consistency and unavailable history remain
visible. Other members' native histories are not scanned automatically. Opening
the selected session uses the existing detail drawer; no token, cost or success
metric is interpolated during playback.
