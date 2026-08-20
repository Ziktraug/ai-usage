import type { SourceControlEntryView, SourceReasonCode } from '@ai-usage/report-core/source-control';
import { sourcesInGroup } from './model';

/**
 * First-run guidance lives beside the sources model rather than inside it because the root layout
 * imports `./model` for the report's collection-status summary: anything added there ships in the
 * initial client closure of every route. This module is reached only from the `/sources` page, so the
 * onboarding copy stays out of the report's first paint (guarded by `src/css-bundle.test.ts`).
 */

const UNDETECTED_INPUT_REASONS: ReadonlySet<SourceReasonCode> = new Set(['input-missing', 'input-unreadable']);

/**
 * Only a source whose input is genuinely absent counts toward the first run. A misconfigured or
 * unsupported source has its own recovery state on its deviation card, and burying that under
 * "install one of these tools" would answer the wrong question.
 *
 * Two axes have to be read together. `inputCount` is the ground truth — a source that counted real
 * input is never "undetected", whatever it reports now — and the detection reason is what separates
 * absence from a configuration fault. Policy complicates the reason: disabling a source overwrites it
 * with `policy-disabled`, so for a disabled source the reason no longer carries detection at all and
 * `availability` (which policy never rewrites) is the only honest read. That fallback is what keeps a
 * deliberately disabled — but previously detected — source from triggering onboarding copy.
 */
const sessionInputUndetected = (source: SourceControlEntryView): boolean => {
  if (source.availability === 'detected' || (source.inputCount ?? 0) > 0) {
    return false;
  }
  return source.policy === 'disabled'
    ? source.availability === 'not-detected'
    : UNDETECTED_INPUT_REASONS.has(source.reason.code);
};

/**
 * True only while every session source on this machine reports no detected input — the first-run case
 * where the honest answer is "install one of these tools, or import usage from another machine".
 */
export const noSessionInputDetected = (sources: readonly SourceControlEntryView[]): boolean => {
  const sessionSources = sourcesInGroup(sources, 'sessions');
  return sessionSources.length > 0 && sessionSources.every(sessionInputUndetected);
};

export interface SessionHistoryLocation {
  readonly harness: string;
  readonly paths: readonly string[];
}

/**
 * Static onboarding copy, deliberately not derived from the collectors: it answers "what do I install
 * and where does ai-usage look?" before any source has run. README.md remains the concise installation
 * reference; this first-run surface may list additional platform-specific locations that the collector
 * accepts so the recovery instructions stay correct on Linux, macOS, and Windows.
 */
export const sessionHistoryLocations: readonly SessionHistoryLocation[] = [
  { harness: 'Claude Code', paths: ['~/.claude/projects/**/*.jsonl', '~/.claude.json'] },
  { harness: 'Codex', paths: ['~/.codex/sessions/**/*.jsonl'] },
  {
    harness: 'OpenCode',
    paths: [
      '~/.local/share/opencode/opencode.db',
      '~/Library/Application Support/opencode/opencode.db',
      '~/AppData/Local/opencode/opencode.db',
    ],
  },
  {
    harness: 'Cursor (macOS)',
    paths: ['~/Library/Application Support/Cursor/User/globalStorage/state.vscdb'],
  },
];
