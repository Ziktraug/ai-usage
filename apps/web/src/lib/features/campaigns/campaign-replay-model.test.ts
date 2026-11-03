import { expect, test } from 'bun:test';
import type { CampaignMap, CampaignMapNode } from '@ai-usage/report-core/campaign-map';
import { parseSessionDetailResponse } from '@ai-usage/report-core/session-detail';
import { sessionDetailFixtureResponse } from '../sessions/detail/session-detail.fixtures';
import { campaignReplayFixture, fractionalCampaignReplayFixture } from './campaign-replay-fixture';
import { campaignReplay, MAX_REPLAY_EVENTS, replayNativeDetail, replayPhase } from './campaign-replay-model';

test('seek uses half-open observed spans and never fills incomplete timing', () => {
  const node = { timingStatus: 'recorded', startMs: 100, endMs: 200 } as CampaignMapNode;
  expect(replayPhase(node, 99)).toBe('before');
  expect(replayPhase(node, 100)).toBe('observed-span');
  expect(replayPhase(node, 200)).toBe('after');
  expect(replayPhase({ ...node, endMs: 100 }, 100)).toBe('after');
  expect(replayPhase({ ...node, timingStatus: 'missing-end', endMs: null }, 1000)).toBe('timing-unavailable');
});

test('bounds the displayed family while retaining full known time and omitted count', () => {
  const map = {
    observedFromMs: 100,
    observedToMs: 1000,
    nodes: Array.from({ length: 150 }, () => ({})),
    omittedCount: 10,
  } as CampaignMap;
  const replay = campaignReplay(map);
  expect(replay.nodes).toHaveLength(120);
  expect(replay.omitted).toBe(40);
  expect(replay.to).toBe(1000);
});

test('native rounds and events follow the cursor without revealing future prompts', () => {
  const response = sessionDetailFixtureResponse('revision', 'row');
  if (response.status !== 'available') {
    throw new Error('Expected synthetic detail');
  }
  const detail = response.detail;
  const start = Date.parse(detail.startedAt);
  expect(replayNativeDetail(detail, start - 1).events).toEqual([]);
  const opening = replayNativeDetail(detail, start);
  expect(opening.round?.index).toBe(0);
  expect(opening.startedRounds).toBe(1);
  expect(opening.events.map((event) => event.kind).sort()).toEqual(['Prompt', 'Round starts']);
  const later = replayNativeDetail(detail, start + 60_000);
  expect(later.round?.index).toBe(1);
  expect(later.events.some((event) => event.kind === 'Round ends')).toBe(true);
  const end = replayNativeDetail(detail, Date.parse(detail.endedAt));
  expect(end.events).toHaveLength(MAX_REPLAY_EVENTS);
  expect(end.omittedEvents).toBe(40);
  expect(replayNativeDetail(detail, start)).toEqual(opening);
});

test('native interaction timestamps are preserved and declared parentage does not invent a spawn event', () => {
  const response = parseSessionDetailResponse(campaignReplayFixture('synthetic-campaign-map-v1'));
  if (response.status !== 'available') {
    throw new Error('Expected available fixture');
  }
  const start = Date.parse(response.detail.startedAt);
  expect(replayNativeDetail(response.detail, start).events.some((entry) => entry.kind === 'Message')).toBe(false);
  const frame = replayNativeDetail(response.detail, start + 300_000);
  expect(frame.events.filter((entry) => entry.kind === 'Message')).toHaveLength(1);
  expect(frame.events.some((entry) => entry.kind === 'Spawn')).toBe(false);
});

for (const duration of [500, 1500]) {
  test(`preserves native events and the recorded end at exactly ${duration} ms`, () => {
    const response = parseSessionDetailResponse(fractionalCampaignReplayFixture('fractional-replay', duration));
    if (response.status !== 'available') {
      throw new Error('Expected fractional fixture');
    }
    const startMs = Date.parse(response.detail.startedAt);
    const endMs = Date.parse(response.detail.endedAt);
    expect(endMs - startMs).toBe(duration);
    expect(replayNativeDetail(response.detail, endMs - 1).events.map((event) => event.text)).not.toContain(
      'Final fractional replay event',
    );
    expect(replayNativeDetail(response.detail, endMs).events.map((event) => event.text)).toContain(
      'Final fractional replay event',
    );
    expect(replayPhase({ timingStatus: 'recorded', startMs, endMs } as CampaignMapNode, endMs)).toBe('after');
  });
}
