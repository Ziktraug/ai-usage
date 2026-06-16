import { harnessLabel } from '@ai-usage/core/harness-metadata';
import type { Row } from '@ai-usage/core/types';
import { actualCost, approximateApiCost, normalizeUsageRow } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessions } from '../codex-history';
import { withProjectPath, withSource } from '../rtk-enrichment';
import { base } from '../text';

export const collectCodex = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) return [];

  const rows: Row[] = [];
  for (const session of yield* readCodexUsageSessions) {
    rows.push(
      withSource(
        withProjectPath(
          normalizeUsageRow({
            date: session.start,
            endDate: session.end,
            harness: harnessLabel('codex'),
            provider: session.subscription ? 'Codex sub' : 'Codex API',
            name: session.name,
            model: session.model,
            project: base(session.cwd),
            tokens: session.tokens,
            cost: session.subscription ? actualCost(0) : approximateApiCost,
            calls: session.calls,
            turns: session.turns,
            tools: session.tools,
            linesAdded: null,
            linesDeleted: null,
            subagent: session.hasSubagents,
          }),
          session.cwd,
        ),
        { harnessKey: 'codex', sourceSessionId: session.id, sourcePath: session.cwd },
      ),
    );
  }

  return rows;
});
