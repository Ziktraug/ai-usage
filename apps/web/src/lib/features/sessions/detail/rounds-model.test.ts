import { describe, expect, test } from 'bun:test';
import type { SessionDetail, SessionDetailResponse, SessionDetailTurn } from '@ai-usage/report-core/session-detail';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../../../query/client';
import { sessionDetailQueryOptions } from '../../../query/options/session';
import type { SessionClientAdapter } from '../../../rpc/session-client';
import {
  buildRoundsView,
  buildRoundsViewForRevision,
  interactionTitle,
  promptExcerpt,
  promptOpening,
  roundTitle,
} from './rounds-model';

const tokens = { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 };
const complete = { omittedCount: 0, reasons: [], status: 'complete' as const };

const turn = (index: number, startAt: string, endAt: string, promptIds: string[]): SessionDetailTurn => ({
  calls: 3,
  cost: 0.5,
  costKind: 'approximate',
  durationMs: null,
  effort: null,
  effortKind: 'unavailable',
  endAt,
  index,
  intervals: [],
  model: 'claude-sonnet-4-6',
  promptIds,
  startAt,
  timingStatus: 'unavailable',
  tokens,
  tools: 2,
});

const detail: SessionDetail = {
  activeDurationMs: null,
  children: [
    {
      agentType: 'Explore',
      evidence: 'claude-agent-link',
      label: 'Find loaders',
      sourceSessionId: 'agent-a',
      spawnTurnIndex: 0,
    },
    { agentType: null, evidence: 'codex-thread-edge', label: null, sourceSessionId: 'thread-b', spawnTurnIndex: null },
  ],
  coverage: {
    childDiscovery: complete,
    grouping: { omittedCount: 1, reasons: ['unattributed-activity'], status: 'partial' },
    interactionAttribution: complete,
    promptBodies: complete,
    recordedTiming: { omittedCount: 2, reasons: ['timing-not-recorded'], status: 'unavailable' },
  },
  durationStatus: 'unavailable',
  efforts: [],
  elapsedDurationMs: 3_600_000,
  endedAt: '2026-08-17T11:00:00.000Z',
  idleDurationMs: null,
  interactions: [
    {
      at: '2026-08-17T10:00:10.000Z',
      childSourceSessionId: 'agent-a',
      kind: 'spawn',
      label: 'Find loaders',
      toolUseId: 't1',
      turnIndex: 0,
    },
    {
      at: '2026-08-17T10:30:10.000Z',
      childSourceSessionId: 'agent-a',
      kind: 'message',
      label: 'Go deeper',
      toolUseId: 't2',
      turnIndex: 1,
    },
    {
      at: '2026-08-17T10:40:00.000Z',
      childSourceSessionId: null,
      kind: 'spawn',
      label: 'Lost launch',
      toolUseId: 't3',
      turnIndex: null,
    },
  ],
  models: ['claude-sonnet-4-6'],
  observedAt: '2026-08-17T11:00:01.000Z',
  phases: [],
  prompts: [
    {
      id: 'p1',
      text: 'Migrate   every\nroute to TanStack Start, keeping parity.',
      timestamp: '2026-08-17T10:00:00.000Z',
      truncated: false,
    },
    { id: 'p2', text: '', timestamp: '2026-08-17T10:30:00.000Z', truncated: true },
  ],
  promptsTruncated: true,
  sourceSessionId: 'root',
  startedAt: '2026-08-17T10:00:00.000Z',
  turns: [
    turn(0, '2026-08-17T10:00:00.000Z', '2026-08-17T10:20:00.000Z', ['p1']),
    turn(1, '2026-08-17T10:30:00.000Z', '2026-08-17T10:35:00.000Z', ['p2']),
    turn(2, '2026-08-17T10:50:00.000Z', '2026-08-17T10:55:00.000Z', []),
  ],
  turnsStatus: 'partial',
};

const memberRow = (sourceSessionId: string): SessionPresentationRow =>
  ({
    rowId: `row-${sourceSessionId}`,
    sessionLabel: sourceSessionId,
    source: { harnessKey: 'claude', sourceSessionId },
  }) as unknown as SessionPresentationRow;

describe('rounds view', () => {
  test('keeps retained rounds separate from new member values until their exact revision commits', async () => {
    const pending = Promise.withResolvers<SessionDetailResponse>();
    const unexpected = (): Promise<never> => Promise.reject(new Error('Unexpected session acquisition'));
    const client: SessionClientAdapter = {
      campaignChildren: unexpected,
      detail: () => pending.promise,
      lookup: unexpected,
      neighbors: unexpected,
      page: unexpected,
      vcs: unexpected,
    };
    const queryClient = createWebQueryClient();
    const response: SessionDetailResponse = {
      consistency: { checkedFields: ['tokens'], status: 'matches-report' },
      detail,
      revision: 'revision-a',
      status: 'available',
    };
    const member = { ...memberRow('agent-a'), costApprox: 99.75, freshTokens: 999_777 };
    const initial = sessionDetailQueryOptions(client, { revision: 'revision-a', rowId: 'root' }, { browser: true });
    const replacement = sessionDetailQueryOptions(client, { revision: 'revision-b', rowId: 'root' }, { browser: true });
    queryClient.setQueryData(initial.queryKey, response);
    const observer = new QueryObserver(queryClient, initial);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      observer.setOptions(replacement);
      const retained = observer.getCurrentResult();
      expect(retained.isPlaceholderData).toBe(true);
      if (retained.data?.status !== 'available') {
        throw new Error('The previous exact session history must remain available');
      }
      expect(retained.data.revision).toBe('revision-a');
      const previous = buildRoundsViewForRevision(retained.data ?? null, 'revision-b', [member]);
      expect(previous?.rounds[0]?.prompts).toEqual([detail.prompts[0]!]);
      expect(previous?.rounds[0]?.interactions[0]?.child?.row).toBeNull();
      expect(previous?.children[0]?.row).toBeNull();

      pending.resolve({ ...response, revision: 'revision-b' });
      await queryClient.fetchQuery(replacement);
      const committed = observer.getCurrentResult();
      expect(committed.isPlaceholderData).toBe(false);
      const current = buildRoundsViewForRevision(committed.data ?? null, 'revision-b', [member]);
      expect(current?.rounds[0]?.id).toBe(previous?.rounds[0]?.id);
      expect(current?.rounds[0]?.prompts).toEqual(previous?.rounds[0]?.prompts);
      expect(current?.rounds[0]?.interactions[0]?.child?.row).toMatchObject({
        costApprox: 99.75,
        freshTokens: 999_777,
      });
      expect(current?.children[0]?.row).toBe(member);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  test('orders rounds, joins children to member rows, and keeps unattributed interactions visible', () => {
    const view = buildRoundsView(detail, [memberRow('agent-a')]);
    expect(view.rounds.map((round) => [round.index, round.kind, round.excerpt])).toEqual([
      [0, 'prompt', 'Migrate every route to TanStack Start, keeping parity.'],
      [1, 'prompt', ''],
      [2, 'unattributed', ''],
    ]);
    expect(view.rounds[0]?.interactions.map(interactionTitle)).toEqual(['Launched Find loaders']);
    expect(view.rounds[1]?.interactions.map(interactionTitle)).toEqual([
      'Message to Find loaders · launched in round 1',
    ]);
    expect(view.rounds[0]?.interactions[0]?.child?.row?.rowId).toBe('row-agent-a');
    expect(view.children.map((child) => [child.sourceSessionId, child.spawnRoundIndex, child.row === null])).toEqual([
      ['agent-a', 0, false],
      ['thread-b', null, true],
    ]);
    expect(view.unattributedInteractions.map((interaction) => interaction.label)).toEqual(['Lost launch']);
    expect(view.unroundedChildren.map((child) => child.sourceSessionId)).toEqual(['thread-b']);
    expect(view.interactionEvidence).toBe('recorded');
    expect(
      buildRoundsView(
        {
          ...detail,
          coverage: {
            ...detail.coverage,
            interactionAttribution: {
              omittedCount: null,
              reasons: ['harness-no-spawn-evidence'],
              status: 'unavailable',
            },
          },
          interactions: [],
        },
        [],
      ).interactionEvidence,
    ).toBe('unavailable');
    expect(view.coverageNotes).toEqual([
      {
        key: 'grouping',
        text: 'Rounds are partial: some activity could not be attributed to a prompt (1 omitted).',
        tone: 'neutral',
      },
      {
        key: 'recordedTiming',
        text: 'Recorded time is partial: the harness did not record active time (2 omitted).',
        tone: 'warning',
      },
    ]);
  });

  test('titles rounds and truncates prompts by lines and characters', () => {
    expect(roundTitle({ excerpt: '', index: 4, kind: 'prompt' })).toBe('Round 5');
    expect(roundTitle({ excerpt: '', index: 0, kind: 'unattributed' })).toBe('Activity without a prompt');
    expect(promptExcerpt(`${'a'.repeat(200)} tail`, 20)).toBe(`${'a'.repeat(20)}…`);
    const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    expect(promptOpening(long, 3)).toEqual({ text: 'line 1\nline 2\nline 3', truncated: true });
    expect(promptOpening('short', 3)).toEqual({ text: 'short', truncated: false });
    expect(promptOpening(`${'word '.repeat(10)}tail`, 3, 24)).toEqual({ text: 'word word word word', truncated: true });
    expect(promptOpening('x'.repeat(30), 3, 24)).toEqual({ text: 'x'.repeat(24), truncated: true });
  });
});
