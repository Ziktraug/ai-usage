import type { CampaignMap, CampaignMapNode } from '@ai-usage/report-core/campaign-map';
import { deriveSessionRounds, type SessionDetail } from '@ai-usage/report-core/session-detail';

export const MAX_REPLAY_SESSIONS = 120;
export const MAX_REPLAY_EVENTS = 80;
export type ReplayPhase = 'before' | 'observed-span' | 'after' | 'timing-unavailable';

/** Half-open recorded spans include idle gaps; this never classifies current activity. */
export const replayPhase = (node: CampaignMapNode, cursor: number): ReplayPhase => {
  if (node.timingStatus !== 'recorded' || node.startMs === null || node.endMs === null) {
    return 'timing-unavailable';
  }
  if (cursor < node.startMs) {
    return 'before';
  }
  return cursor >= node.endMs ? 'after' : 'observed-span';
};

export const campaignReplay = (map: CampaignMap) => ({
  from: map.observedFromMs,
  to: map.observedToMs,
  nodes: map.nodes.slice(0, MAX_REPLAY_SESSIONS),
  omitted: map.omittedCount + Math.max(0, map.nodes.length - MAX_REPLAY_SESSIONS),
});

export interface ReplayEvent {
  at: number;
  id: string;
  kind: 'Prompt' | 'Round starts' | 'Round ends' | 'Spawn' | 'Message';
  text: string;
}

/** Only observed timestamps enter the feed. No interpolation of tokens, tools or events. */
export const replayNativeDetail = (detail: SessionDetail, cursor: number) => {
  const rounds = deriveSessionRounds(detail);
  const events: ReplayEvent[] = [
    ...detail.prompts.map((prompt) => ({
      at: Date.parse(prompt.timestamp),
      id: `prompt:${prompt.id}`,
      kind: 'Prompt' as const,
      text: `${prompt.text || 'Prompt body unavailable'}${prompt.truncated ? ' (truncated)' : ''}`,
    })),
    ...detail.interactions.map((interaction, index) => ({
      at: Date.parse(interaction.at),
      id: `interaction:${index}`,
      kind: interaction.kind === 'spawn' ? ('Spawn' as const) : ('Message' as const),
      text: interaction.label ?? 'Recorded interaction; content unavailable',
    })),
    ...rounds.flatMap((round) => [
      {
        at: Date.parse(round.startAt),
        id: `${round.id}:start`,
        kind: 'Round starts' as const,
        text: `Round ${round.index + 1} · ${round.model}`,
      },
      {
        at: Date.parse(round.endAt),
        id: `${round.id}:end`,
        kind: 'Round ends' as const,
        text: `Round ${round.index + 1} · observed elapsed ${Math.round(round.observedSpanMs / 1000)} s`,
      },
    ]),
  ]
    .filter((event) => Number.isFinite(event.at) && event.at <= cursor)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const startedRounds = rounds.filter((round) => Date.parse(round.startAt) <= cursor);
  return {
    events: events.slice(-MAX_REPLAY_EVENTS),
    omittedEvents: Math.max(0, events.length - MAX_REPLAY_EVENTS),
    round: startedRounds.at(-1) ?? null,
    startedRounds: startedRounds.length,
    totalRounds: rounds.length,
  };
};
