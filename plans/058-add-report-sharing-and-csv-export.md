# Plan 058: Add Report Sharing and Safe CSV Export

> Export only the active focused breakdown. Never trigger local-history reads,
> collection, or server filesystem writes. Update plan 058 in the index.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/dashboard.tsx apps/web/src/group-panel.tsx apps/web/src/project-summary.tsx packages/report-core/src/provenance.ts`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: plans 053 and 054
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked product boundary

Add “Copy link” using the current URL and “Export CSV” only for the active
Models, Providers, Harnesses, or Projects breakdown. Export visible filtered and
sorted groups only.

Analytics CSV columns, in this exact order:

`label,sessions,fresh_tokens,cache_read_tokens,cache_hit_percent,api_value_known,api_value_display,api_value_measurement,fully_priced_sessions,total_sessions,unpriced_fresh_tokens,turns,tools`

Projects CSV columns, in this exact order:

`label,sessions,fresh_tokens,cache_read_tokens,api_value_known,api_value_display,api_value_measurement,fully_priced_sessions,total_sessions,lines_added,lines_deleted,line_measured_sessions,line_total_sessions,turns,tools`

`api_value_measurement` is `complete|partial|unavailable`. Numeric fields stay
unformatted decimal integers/numbers. Neutralize spreadsheet formulas in string
fields by prefixing values beginning with `=`, `+`, `-`, or `@` with a single
quote before RFC-4180 escaping.

## Scope

- `apps/web/src/dashboard.tsx`
- `apps/web/src/report-export.ts` (create)
- `apps/web/src/report-export.test.ts` (create)
- `apps/web/src/group-panel.tsx`
- `apps/web/src/project-summary.tsx`
- `apps/web/e2e/dashboard.spec.ts`

No PNG, sessions export, server endpoint, HTML export, hidden groups, prompt
bodies, or filesystem destination.

## Steps

### Step 1: Build pure typed CSV projections

Test commas, quotes, newlines, Unicode, formula prefixes, and every provenance
state. Use explicit columns per group type.

**Verify**: `bun test apps/web/src/report-export.test.ts` → all pass.

### Step 2: Copy the current link

Use Clipboard API with an inline success/error notice; no `alert`.

**Verify**: component/E2E test receives the exact current URL.

### Step 3: Download the active breakdown

Use a Blob/object URL, revoke it, and name the file from report generated date:
`ai-usage-<dimension>-<YYYY-MM-DD>.csv`.

**Verify**: E2E parses the download and matches visible row order and values.

### Step 4: Run gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass.

## STOP conditions

- Export needs data absent from the active focused result.
- Any field could contain prompts or credentials.
- A provenance state cannot be represented without guessing.
