# ADR 0086: Retire Cursor commit attribution

- **Status**: Accepted
- **Date**: 2026-11-02
- **Extends**: 0075 (preservation and widen-only reads)

## Context

Cursor's AI-versus-human line share is approximately 100% for this operator,
and Cursor sees only its own commits: on the operator's store (46 scored
commits, February–August 2026), about 88% of added lines carried no attribution
because other harnesses wrote them. The breakdown no longer informs a
decision, but costs collection, storage APIs, report contracts and UI.

## Decision

Retire the `cursor.commit-attribution` collection source, the
`cursorCommitAttribution` dataset, its legacy `facets.cursor.commitAttribution`
form, and the Cursor AI breakdown tab. Cursor session collection and usage
rows remain unchanged.

There is no schema migration or schema-version change. Existing dataset-item
tables, rows, and source-state/outcome records remain in place, unread. No
stored revision is rewritten. Old served support and breakdown projections
and portable usage snapshots load while intentionally dropping retired
attribution. Merge bundles never carried attribution, so their strict parser is
unchanged. Existing home policy
overrides are inert and do not list or schedule the source. Old
`/?tab=cursor-ai` bookmarks select Models, the default breakdown.

Remove the now-unused normalized dataset-item read/write machinery, not its
SQLite tables. Current provider-status collection keeps its existing path.

## Consequences

Reports no longer promise commit authorship coverage. Historical data is
preserved, but is not displayed or exported by current report readers.
No daily-store access is needed to implement or test retirement; fixture
tests do not establish live-store safety or a downgrade path.

## Rejected alternative

Keeping the feature hidden but collecting it would retain its maintenance
cost without serving an operator decision. Deleting persisted rows would
violate the preservation constraint and is unnecessary.

## Evidence

- [Dataset compatibility](../../packages/report-core/src/datasets.ts)
- [Focused report decoders](../../packages/report-core/src/focused-report-query.ts)
- [Stored report preservation regression](../../packages/report-data/src/reporting.test.ts)
- [Source catalogue](../../packages/report-core/src/source-control.ts)
- [Local store upgrade procedure](../local-store-upgrade.md)
