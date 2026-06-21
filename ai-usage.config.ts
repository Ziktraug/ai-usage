import type { AiUsageConfig } from '@ai-usage/report-core/project-alias';

const config = {
  cursor: {
    // Local import directory for Cursor dashboard usage-event CSV exports.
    // Use: bun apps/cli/src/main.ts cursor import /path/to/export.csv
    // The directory is ignored by git because exports contain user/cost history.
    usageExportDir: './.ai-usage/cursor-exports',

    // Consecutive Cursor usage events closer than this are treated as one
    // Composer session candidate. The cluster ignores model because Cursor can
    // switch models within a single Composer session.
    clusterGapMs: 5 * 60 * 1000,

    // Match a CSV cluster to a local Composer when their starts are within this
    // window. Ambiguous matches are kept but marked in the report.
    reconcileWindowMs: 3 * 60 * 1000,

    // Safety cap for local Composer windows. Without this, if local history has
    // no Composer until days later, a stale session could absorb unrelated CSV
    // usage events. Events outside this span become standalone export rows.
    maxSessionSpanMs: 60 * 60 * 1000,

    // Optional user filtering can be configured in ~/.config/ai-usage/config.json
    // for team exports. Keep this repo config free of personal identifiers.
  },
} satisfies AiUsageConfig;

export default config;
