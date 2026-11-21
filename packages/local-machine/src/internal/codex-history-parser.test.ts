import { describe, expect, test } from 'bun:test';
import { createCodexSessionParser } from './codex-history';

// The parser keeps at most this many open native tasks (CODEX_DETAIL_MAX_TURNS).
const MAX_OPEN_TASKS = 1024;

const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

const sessionMeta = JSON.stringify({
  payload: { cwd: '/fixture/project', id: 'capacity-session', timestamp: at(0) },
  timestamp: at(0),
  type: 'session_meta',
});

const taskStarted = (turnId: string, second: number): string =>
  JSON.stringify({
    payload: { turn_id: turnId, type: 'task_started' },
    timestamp: at(second),
    type: 'event_msg',
  });

const turnContext = (turnId: string, second: number): string =>
  JSON.stringify({
    payload: { model: 'gpt-fixture', turn_id: turnId },
    timestamp: at(second),
    type: 'turn_context',
  });

const fillOpenTasks = (withContext: boolean) => {
  const parser = createCodexSessionParser();
  parser.visit(sessionMeta);
  for (let index = 0; index < MAX_OPEN_TASKS; index++) {
    parser.visit(taskStarted(`turn-${index}`, 1));
    if (withContext) {
      parser.visit(turnContext(`turn-${index}`, 1));
    }
  }
  return parser;
};

describe('Codex session parser open-task capacity (characterization)', () => {
  test('evicts the oldest task without context to admit a new task at capacity', () => {
    const parser = fillOpenTasks(false);
    parser.visit(taskStarted('turn-new', 2));

    expect(parser.evidenceContext('turn-0')).toBeNull();
    expect(parser.evidenceContext('turn-1')).toEqual({ hasContext: false, replayed: false, turnId: 'turn-1' });
    expect(parser.evidenceContext('turn-new')).toEqual({ hasContext: false, replayed: false, turnId: 'turn-new' });
  });

  test('drops a new task at capacity when every open task already has context', () => {
    const parser = fillOpenTasks(true);
    parser.visit(taskStarted('turn-new', 2));

    expect(parser.evidenceContext('turn-new')).toBeNull();
    expect(parser.evidenceContext('turn-0')).toEqual({ hasContext: true, replayed: false, turnId: 'turn-0' });
    expect(parser.finish().session.turns).toBe(MAX_OPEN_TASKS);
  });

  test('restarts an already-open task at capacity without evicting another one', () => {
    const parser = fillOpenTasks(false);
    parser.visit(taskStarted('turn-7', 2));

    expect(parser.evidenceContext('turn-0')).toEqual({ hasContext: false, replayed: false, turnId: 'turn-0' });
    expect(parser.evidenceContext('turn-7')).toEqual({ hasContext: false, replayed: false, turnId: 'turn-7' });
  });
});
