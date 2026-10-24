import { describe, expect, test } from 'bun:test';
import { parseWorkThreadCommand } from '@ai-usage/report-core/work-thread';
import { parse, safeParse } from 'valibot';
import {
  workThreadEpisodeSchema,
  workThreadsCommandInputSchema,
  workThreadsCommandOutputSchema,
  workThreadsDetailInputSchema,
  workThreadsListInputSchema,
  workThreadsListOutputSchema,
} from './work-threads';

const id = '10000000-0000-4000-8000-000000000001';
const at = '2026-10-24T10:00:00.000Z';
const query = { cursor: null, limit: 50, project: null, search: null, tab: 'open' } as const;
const base = {
  commandId: id,
  expectedRevision: 1,
  op: 'set-follow-state',
  threadId: id,
  to: 'done',
  reason: null,
  waitingFor: null,
  waitingOn: null,
  acknowledgedRemainders: ['PR remains open'],
};
const episode = {
  children: [],
  durationBasis: 'span',
  durationMs: 60_000,
  endedAt: at,
  firstPrompt: null,
  harness: 'codex',
  lastInstruction: null,
  launchedBy: null,
  linkKey: 'session:test/codex/one',
  machineId: 'test',
  origin: 'human',
  projectLabel: 'Test',
  question: null,
  result: null,
  resume: { kind: 'none', reason: 'No verified resume command.' },
  running: false,
  sourceSessionId: 'one',
  startedAt: at,
  title: 'Synthetic session',
};

describe('Work thread wire contract', () => {
  test('list identities are bounded and exact, detail requires a UUID', () => {
    expect(parse(workThreadsListInputSchema, query)).toEqual(query);
    for (const patch of [
      { limit: 101 },
      { limit: 0 },
      { tab: 'waiting' },
      { search: 'x'.repeat(201) },
      { unknown: true },
    ]) {
      expect(safeParse(workThreadsListInputSchema, { ...query, ...patch }).success).toBe(false);
    }
    expect(safeParse(workThreadsDetailInputSchema, { threadId: 'not-an-id' }).success).toBe(false);
    expect(parse(workThreadsDetailInputSchema, { threadId: id })).toEqual({ threadId: id });
  });
  test('commands are validated and normalized by the frozen parser', () => {
    const frozen = parseWorkThreadCommand(base);
    if (frozen === null) {
      throw new Error('Invalid fixture command.');
    }
    expect(parse(workThreadsCommandInputSchema, base)).toEqual(frozen);
    for (const patch of [
      { expectedRevision: 0 },
      { commandId: 'reused-label' },
      { to: 'merged' },
      { force: true },
      { waitingFor: 'review' },
    ]) {
      expect(safeParse(workThreadsCommandInputSchema, { ...base, ...patch }).success).toBe(false);
    }
    expect(
      parse(workThreadsCommandInputSchema, { commandId: id, op: 'create', title: 'Synthetic analysis' }),
    ).toMatchObject({ objective: null, links: [], intent: null });
  });
  test('all typed command failures preserve revisions and replay outcomes', () => {
    expect(
      parse(workThreadsCommandOutputSchema, { ok: true, applied: false, followRevision: 2, threadId: id }),
    ).toMatchObject({ applied: false, followRevision: 2 });
    for (const failure of ['not-found', 'revision-conflict', 'invalid-transition', 'invalid-link']) {
      expect(
        parse(workThreadsCommandOutputSchema, { ok: false, currentRevision: 2, failure, message: 'The task changed.' }),
      ).toMatchObject({ failure });
    }
    expect(
      safeParse(workThreadsCommandOutputSchema, { ok: true, applied: true, followRevision: 0, threadId: id }).success,
    ).toBe(false);
    expect(
      safeParse(workThreadsCommandOutputSchema, {
        ok: false,
        failure: 'unavailable',
        message: 'Unavailable',
        currentRevision: null,
      }).success,
    ).toBe(false);
  });
  test('empty datasets and unavailable reads remain distinct; malformed sources are rejected', () => {
    const data = {
      counts: { done: 0, open: 0 },
      generatedAt: at,
      machineId: 'test',
      nextCursor: null,
      projects: [],
      rows: [],
      sources: [{ lastRunAt: at, message: 'Synthetic', source: 'github', state: 'unauthenticated' }],
    };
    expect(parse(workThreadsListOutputSchema, { ok: true, data })).toMatchObject({
      ok: true,
      data: { rows: [], sources: [{ state: 'unauthenticated' }] },
    });
    expect(
      parse(workThreadsListOutputSchema, { ok: false, error: { tag: 'Unavailable', message: 'No reader binding.' } }),
    ).toMatchObject({ ok: false });
    expect(
      safeParse(workThreadsListOutputSchema, { ok: true, data: { ...data, sources: [{ state: 'ignored' }] } }).success,
    ).toBe(false);
    expect(
      safeParse(workThreadsListOutputSchema, { ok: true, data: { ...data, generatedAt: new Date(at) } }).success,
    ).toBe(false);
  });
  test('nested delegation preserves descendants and rejects invalid or excessive nesting', () => {
    expect(
      parse(workThreadEpisodeSchema, { ...episode, children: [{ ...episode, children: [episode] }] }),
    ).toMatchObject({ children: [{ children: [episode] }] });
    expect(safeParse(workThreadEpisodeSchema, { ...episode, children: [{ ...episode, durationMs: -1 }] }).success).toBe(
      false,
    );
    expect(
      safeParse(workThreadEpisodeSchema, { ...episode, children: Array.from({ length: 21 }, () => episode) }).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = { ...episode };
    cyclic.children = [cyclic];
    expect(safeParse(workThreadEpisodeSchema, cyclic).success).toBe(false);
  });
});
