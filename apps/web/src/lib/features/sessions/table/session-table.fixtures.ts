import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { enrichSessionPresentationRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';

const baseRow = (index: number): SerializedRow => ({
  activeDate: `2026-08-${String((index % 27) + 1).padStart(2, '0')}T12:30:00.000Z`,
  ambiguous: false,
  calls: index + 1,
  costActual: index / 10,
  costApprox: index / 10,
  costKnown: true,
  date: `2026-08-${String((index % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
  durationMs: 60_000 * (index + 1),
  endDate: `2026-08-${String((index % 27) + 1).padStart(2, '0')}T12:30:00.000Z`,
  freshTokens: 1000 + index,
  harness: index % 2 === 0 ? 'Codex' : 'Claude',
  linesAdded: index,
  linesDeleted: index,
  lineDelta: index * 2,
  model: 'gpt-5.4',
  name: `Synthetic session ${index}`,
  origin: 'human',
  partial: false,
  project: 'synthetic-project',
  provider: 'Synthetic provider',
  sessionLabel: `Synthetic session ${index}`,
  source: {
    harnessKey: 'codex',
    machineId: 'synthetic-machine',
    machineLabel: 'Synthetic machine',
    sourceSessionId: `synthetic-${index}`,
  },
  subagent: false,
  tokCr: 2000 + index,
  tokCw: 300 + index,
  tokIn: 500 + index,
  tokOut: 200 + index,
  tokenTotal: 3000 + index * 4,
  tools: index,
  turns: index + 2,
});

export const syntheticSessionRow = (index: number): SessionPresentationRow =>
  enrichSessionPresentationRow(baseRow(index));

export const syntheticSessionRows = (count: number, startIndex = 0): SessionPresentationRow[] =>
  Array.from({ length: count }, (_, index) => syntheticSessionRow(startIndex + index));

export const syntheticCampaignRow = (
  index: number,
  children: readonly SessionPresentationRow[] = [],
): SessionPresentationRow => ({
  ...syntheticSessionRow(index),
  campaignKey: `synthetic-campaign-${index}`,
  campaignTotalCount: children.length + 1,
  campaignVisibleCount: children.length + 1,
  ...(children.length === 0 ? {} : { children: [...children] }),
});
