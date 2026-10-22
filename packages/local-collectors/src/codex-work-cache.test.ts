import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { Effect } from 'effect';
import { collectCodexResult } from './collectors/codex';

test('C05: Codex request observations survive warm cache and an old parser version forces recollection', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-work-cache-'));
  try {
    const directory = path.join(home, '.codex', 'sessions', '2026');
    mkdirSync(directory, { recursive: true });
    const events = [
      {
        timestamp: '2026-10-22T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'cache-work', cwd: '/work/fixture', originator: 'Codex Desktop', source: 'vscode' },
      },
      {
        timestamp: '2026-10-22T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'q',
          name: 'request_user_input_async',
          arguments: JSON.stringify({ questions: [{ title: 'Faut-il continuer ?' }] }),
        },
      },
      {
        timestamp: '2026-10-22T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'q', output: JSON.stringify({ accepted: true }) },
      },
    ];
    writeFileSync(path.join(directory, 'fixture.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
    const collect = () =>
      Effect.runPromise(
        collectCodexResult.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
      );
    const cold = await collect();
    const hot = await collect();
    expect(hot.workObservations).toEqual(cold.workObservations);
    expect(hot.workObservations[0]?.requests[0]).toMatchObject({
      acknowledgedAt: events[2]?.timestamp,
      questions: [{ answeredAt: null }],
    });
    expect(JSON.stringify(hot.rows)).not.toContain('Faut-il continuer');
    const cache = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'));
    try {
      cache.exec(
        "UPDATE codex_session_cache SET version = 25, session_json = json_remove(session_json, '$.workObservation')",
      );
    } finally {
      cache.close();
    }
    expect((await collect()).workObservations).toEqual(cold.workObservations);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
