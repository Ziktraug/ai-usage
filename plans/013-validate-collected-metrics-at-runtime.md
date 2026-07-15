# Plan 013: Validate Collector Metrics at Runtime Before Aggregation

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: plan 012, to avoid parallel edits to collector read loops
- **Category**: correctness / defensive parsing / data quality
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `fix/013-runtime-metric-validation`

## Executor instructions

Read this plan completely and compare current collector code with `17bcf28` and
plan 012. Add validation at the untrusted history boundary, before arithmetic.
Do not use TypeScript casts as validation, coerce invalid values, or weaken the
strict portable-file parsers.

Implement the shared primitives and characterization tests first, then migrate
one harness at a time in separate commits if needed.

## Why this matters

`safeJSON<T>` currently parses JSON and casts the result to `T`; it proves
nothing at runtime. Claude, Cursor, OpenCode, and parts of Codex then add token,
cost, and counter fields directly. Strings, negative values, decimals, unsafe
integers, infinities from SQLite, or wrong-shaped objects can produce string
concatenation, `NaN`, overflow, negative totals, and corrupted report metrics.

Local provider files are inputs, not trusted internal objects. One malformed
record must not poison valid rows from the same history, and errors must not
echo private session content.

## Target outcome

1. Usage-bearing records are parsed from `unknown` by narrow runtime validators.
2. Token/counter fields are safe non-negative integers; cost fields are finite
   non-negative numbers.
3. Timestamp and required identity fields are validated before a record joins a
   session.
4. Aggregation uses checked addition and cannot exceed
   `Number.MAX_SAFE_INTEGER` for integer counters.
5. A malformed usage record is ignored as a whole; valid neighboring records
   still contribute.
6. Each harness returns one bounded aggregate warning per collection/category,
   with counts but no raw JSON, path content, prompt, or invalid value.

## Current-state evidence

- `packages/local-collectors/src/text.ts` exposes generic `safeJSON<T>` through
  an unchecked cast.
- Claude directly accumulates usage fields in `collectors/claude.ts`.
- Cursor and OpenCode map database values to arithmetic without a single narrow
  numeric schema.
- Codex validates `total_tokens` more carefully than its nested token fields,
  allowing an invalid subcounter into a cumulative snapshot.
- Cursor CSV uses permissive `parseInt`/`parseFloat`, RTK enrichment uses
  `Number(value) || 0`, and Cursor/OpenCode line facets trust SQLite values.
- Collector/Claude caches revive rows through an unchecked cast; Codex caches
  already-parsed sessions. Old malformed metrics and their missing warning
  summaries can therefore bypass a corrected source parser indefinitely.
- Some collector orchestration already supports results with structured
  warnings, but Claude, Codex, normal Cursor, and dataset/facet paths still need
  an explicit result channel rather than silently dropping diagnostics.

## Scope

### In scope

- a focused private `metric-validation.ts` module and tests;
- `safeJSON` returning `unknown` (or a non-generic parsed JSON value);
- usage-bearing event/row validation for Claude, Cursor, OpenCode, Codex, Cursor
  CSV, and RTK enrichment, including line-change facets;
- runtime validation/versioning of every cache that stores parsed rows/sessions;
- checked integer/cost aggregation;
- result-returning row/dataset adapters and report-data warning propagation;
- structured collector warnings and malformed-record tests.

### Out of scope

- validating every non-metric metadata event in every provider history;
- changing valid provider semantics, pricing, row fields, or report math;
- coercing numeric strings from JSON/SQLite; native Cursor CSV numeric strings
  are accepted only through explicit anchored field grammars;
- clamping invalid values to zero;
- changing snapshot/merge validators or their error messages;
- logging malformed raw records.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/local-collectors/src packages/report-data/src
git status --short -- packages/local-collectors/src packages/report-data/src
bun test packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/local-collectors/src/datasets.test.ts \
  packages/report-data/src/reporting.test.ts
```

If either scoped drift command shows work not produced by plans 011-012, STOP,
preserve it, and rebase/re-read the overlapping collector implementation before
editing, including the report-data dataset seam.

## Runtime contract to freeze

Before migrating collectors, encode these rules in pure tests:

- absent optional metric: use the harness's documented default;
- present invalid metric: reject the entire usage-bearing record;
- tokens, calls, cache counts, turns, and tool counters: integer,
  `Number.isSafeInteger`, and `>= 0`;
- monetary cost: `Number.isFinite` and `>= 0`;
- required string ID/model/session fields: runtime strings and non-empty. This
  metric plan makes no new per-field length-limit claim; plan 012 bounds text
  files, while DB string caps would require a separately characterized contract;
- timestamp: parseable, finite, and within the collector's existing supported
  domain; do not add a new arbitrary date cutoff;
- integer addition: fail the record/session update before exceeding
  `Number.MAX_SAFE_INTEGER`;
- no partial contribution from one rejected record;
- one aggregate warning per harness/category, including rejected count only.

If a provider fixture demonstrates a documented valid negative, fractional, or
unsafe token value, STOP and record that contract rather than normalizing it.

## Implementation steps

### Step 1 - Add pure narrow validators

Create `packages/local-collectors/src/metric-validation.ts` with small helpers
such as:

- `parseNonNegativeSafeInteger`;
- `parseNonNegativeFiniteNumber`;
- checked safe-integer addition;
- non-empty string/timestamp helpers only where collectors share the same exact
  runtime rule; do not invent a string-length cap in this plan.

Return explicit success/failure values; do not throw for every malformed event
inside a large stream. Keep provider-specific object schemas in their provider
module so the shared helper does not become a union of every vendor format.

Test valid zero/positive values, numeric strings, negatives, fractions, unsafe
integers, `NaN`/infinity through direct values, arrays/objects, missing values,
and addition overflow.

Before migration, inventory every numeric value that enters a usage row,
dataset/facet, warning counter, or enrichment with focused `rg` searches for
`Number`, `parseInt`, `parseFloat`, arithmetic assignment, and row field mapping.
The inventory must explicitly include Cursor CSV, RTK, and Cursor/OpenCode line
metrics; record every excluded numeric as non-usage-bearing with rationale.

### Step 2 - Remove the generic JSON trust cast without breaking other callers

Inventory every `safeJSON<T>` caller first. Change the primitive to return
`unknown` (or introduce an untyped replacement and remove/deprecate the generic
one in the same plan), then migrate **all** callers so the repository continues
to typecheck after this step.

Usage-bearing callers receive the full narrow metric schemas in steps 3-5.
Non-metric settings, composer, bubble, index, and quota callers need at least an
`isRecord`/array and field-level predicate before access; they do not need a
complete provider schema rewrite. No caller may restore the old trust with
`as ProviderEvent` or another generic cast.

### Step 3 - Migrate Claude

1. Parse each usage event's object and numeric fields from `unknown`.
2. Validate identity/time fields needed to associate it with a session.
3. Reject an invalid usage event before changing any accumulator.
4. Use checked additions for every integer counter and a finite checked cost
   sum.
5. Preserve valid events in the same JSONL/session.
6. Return a single Claude malformed-usage warning with rejected count.

### Step 4 - Migrate Cursor and OpenCode

1. Treat SQLite values as runtime unknowns despite declared query types.
2. Validate token/cost/counter columns before constructing the intermediate
   usage event/session.
3. Handle `NULL` only where the existing schema treats the field as optional.
4. Reject numeric strings, negative/fractional counters, non-finite direct test
   values, and unsafe integers.
5. Keep source-row/session joins intact for valid rows.
6. Aggregate warnings once per harness, not once per database row.
7. Validate line-added/removed and other numeric composer/session facets before
   they enter a row; invalid facet records follow one explicit reject/omit policy
   and warning count.

Use real SQLite tests for wrong storage classes and overflow combinations.

### Step 5 - Complete Codex validation

1. Parse the entire token-count snapshot narrowly, including every nested
   input/output/cache/reasoning subfield used by aggregation.
2. When a newer cumulative snapshot is invalid, keep the last fully valid
   cumulative snapshot; never mix its valid-looking fields with invalid fields.
3. Validate checked deltas/additions so a malformed cumulative regression or
   overflow cannot create negative/unsafe usage.
4. Keep unrelated prompt-history metadata behavior unchanged.
5. Surface one Codex malformed-usage warning with a rejected count.

### Step 6 - Validate native Cursor CSV and RTK metrics

Cursor CSV transports numbers as strings, so it is the explicit exception to
the JSON/SQLite numeric-string rejection rule. Characterize the supported CSV
examples, then use anchored full-string grammars for:

- non-negative safe integer token fields, including only the documented comma
  grouping/whitespace forms;
- finite non-negative decimal cost, including only documented decimal/currency
  syntax.

Empty optional cells may keep their documented zero/absent behavior. Reject
negative values, fractional token counts, unsafe integers, trailing junk, and
prefix-only parses; never use permissive `parseInt`/`parseFloat` success.

For `rtk-enrichment.ts`, validate SQLite values from `unknown`, use checked safe
integer addition, and never turn an invalid value into zero via
`Number(value) || 0`. Preserve valid commands and aggregate one redacted RTK
warning/count.

### Step 7 - Invalidate and validate parsed-row/session caches

After source validators are in place:

1. bump every affected cache version again (generic Cursor/OpenCode row cache,
   Claude row cache, and Codex Session SQLite cache), even if plan 012 already
   bumped a version for WAL semantics;
2. replace `reviveCollectorRows`' unchecked cast with runtime validation of the
   complete cached row metrics/dates before use;
3. validate Codex cached session payloads and metric columns before returning
   them; any invalid entry/file is a cache miss and source history is reparsed;
4. persist a bounded `rejectedMetricRecords`/equivalent safe-integer summary in
   each cache entry/metadata so a cache hit re-emits the same aggregate warning
   as the source parse;
5. never cache raw malformed values or warning text derived from them.

Test a fresh source containing valid+malformed events followed by an unchanged
cache hit: both runs return identical safe rows and identical intended aggregate
warning semantics. Test old-version and malformed-cache misses.

### Step 8 - Wire bounded warnings through collection results

Standardize every affected harness adapter on a result-returning operation such
as `{ rows, warnings }`: Claude, Cursor, OpenCode, Codex, Cursor CSV, and any RTK
enrichment adapter. `HARNESS_ADAPTERS` and report orchestration must call that
operation. Existing row-only `collect` exports may remain only as thin
compatibility wrappers that call the result operation and discard warnings;
production orchestration must not use those wrappers.

Dataset/facet collection is a separate path today. Change
`collectHarnessDatasets`/`collectReportDatasets` (or a narrowly named adjacent
operation) to return `{ datasets, warnings }` and propagate those warnings
through report-data into the same visible bounded collector-warning surface.
Invalid Cursor/OpenCode attribution or line-change facet records must follow the
Step 4 omit/reject policy and increment the aggregate warning; do not retain the
current catch-to-empty-array behavior without a diagnostic. A valid neighboring
facet/dataset still returns normally.

Warnings must contain only:

- `harness`;
- `operation: 'metricValidation'` (the category);
- a validated non-negative safe-integer rejection count embedded in one fixed
  generic message template of at most 160 characters.

They must not contain raw JSON, offending values, prompts, session titles, full
history paths, SQL rows, or stack dumps. Cap warning cardinality independently
of input record count: at most one warning per `(harness, metricValidation)` for
one collection, with counts summed using checked safe-integer addition. Do not
set `path` or `sql` on these warnings.

### Step 9 - Add per-source regression matrices

For every mapped harness/CSV/enricher, test:

- a normal valid record;
- zero and absent optional values;
- numeric string;
- negative;
- fractional token/counter;
- unsafe integer;
- wrong object/array shape;
- aggregate overflow;
- valid + invalid mixture, where only valid data contributes;
- warning count/content redaction.

For Cursor CSV, invert only the numeric-string case: strictly valid full-field
strings pass, while trailing junk/unsafe/negative/fractional-token strings fail.
For caches, repeat the matrix through both cold parse and cache-hit paths.
Add an explicit dataset test with one valid and one invalid Cursor facet: the
valid dataset remains, exactly one bounded aggregate warning reaches the
report-data result, and neither the invalid value nor source row appears in it.

Also assert that serialized snapshot/merge validation tests are unchanged and
still strict.

## Test plan

```sh
bun test packages/local-collectors/src/metric-validation.test.ts \
  packages/local-collectors/src/collector-cache.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/local-collectors/src/datasets.test.ts \
  packages/local-collectors/src/cursor-csv-reconcile.test.ts \
  packages/local-collectors/src/rtk-enrichment.test.ts \
  packages/report-data/src/reporting.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Done criteria

- No usage/facet/enrichment arithmetic consumes an unvalidated runtime value in
  any mapped harness, Cursor CSV, or RTK path.
- Integer totals remain safe and non-negative; cost totals remain finite and
  non-negative.
- Invalid records never become zero-valued calls or partial contributions.
- Valid records in the same session still contribute.
- Codex retains only fully valid cumulative snapshots.
- Warnings are aggregate, bounded, and content-free.
- Every affected row and dataset adapter has a result channel, and report
  orchestration surfaces its warnings instead of calling a row-only wrapper or
  converting facet failures silently to `[]`.
- No generic cast reintroduces trust after JSON/SQLite parsing.
- Every former `safeJSON<T>` caller compiles through an explicit runtime
  container/field check; none is left for a later plan.
- Parsed-row/session caches validate from `unknown`, use a new version, and
  reproduce safe rows plus aggregate rejection warnings on cache hits.

## STOP conditions

- A supported provider documents valid negative, fractional, or unsafe token
  counters.
- Invalid values are silently clamped/coerced to zero while the record counts.
- One malformed record removes valid neighboring records or a complete harness.
- Raw record content or values appear in warnings/logs.
- The implementation weakens strict portable-file validation.
- A rewrite of unrelated event metadata becomes necessary; split and justify it
  instead.

## Maintenance note

Provider schemas are runtime contracts. New numeric fields require a narrow
parser, a missing/invalid policy, checked aggregation, redacted warning behavior,
and malformed-input tests before they may enter a usage row.
