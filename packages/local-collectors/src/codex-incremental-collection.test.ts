import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalHistoryError } from '@ai-usage/local-machine/errors';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { Effect } from 'effect';
import { type CodexCollectionResult, collectCodexResult, createCodexIncrementalCollector } from './collectors/codex';

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const run = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: LocalHistoryStorageService) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

const tokenCount = (timestamp: string, total: number) => ({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        total_tokens: total,
        input_tokens: total - 10,
        cached_input_tokens: 0,
        output_tokens: 10,
      },
    },
  },
});

/** One native turn with usage, and a skill catalogue naming `skill`, so the rollout carries an observation. */
const rollout = (input: { id: string; minute: number; skill: string; total: number }) => {
  const at = (second: number) =>
    `2026-01-01T00:${String(input.minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
  return jsonl(
    { timestamp: at(0), type: 'session_meta', payload: { id: input.id, cwd: `/work/${input.id}` } },
    {
      timestamp: at(1),
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg-${input.id}`,
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: `### Available skills\n- ${input.skill}: A skill. (file: /home/alex/.agents/skills/${input.skill}/SKILL.md)`,
          },
        ],
      },
    },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${input.id}` } },
    { timestamp: at(3), type: 'turn_context', payload: { model: 'gpt-5.2', turn_id: `turn-${input.id}` } },
    tokenCount(at(4), input.total),
  );
};

/** The whole collection as a value two passes can be compared on, observations left aside. */
const comparable = (result: CodexCollectionResult) => ({
  observationCompleteness: result.observationCompleteness,
  retiredSourceSessionIds: result.retiredSourceSessionIds,
  rows: result.rows,
  warnings: result.warnings,
  workObservations: result.workObservations,
});

const observationKeys = (result: CodexCollectionResult) =>
  result.observations
    .map((observation) => `${observation.sessionId}:${observation.tier}:${observation.skillName}`)
    .sort();

describe('incremental Codex collection', () => {
  let home: string;
  let sessionsDirectory: string;
  let storage: LocalHistoryStorageService;
  let stamp = 1_800_000_000;

  /** Writes a rollout with a distinct mtime, so a rewrite is never hidden by timestamp resolution. */
  const writeRollout = (name: string, content: string) => {
    const filePath = path.join(sessionsDirectory, name);
    writeFileSync(filePath, content);
    stamp += 10;
    utimesSync(filePath, stamp, stamp);
    return filePath;
  };

  /** What a collector with no state returns for the current files. */
  const fullCollection = () => run(collectCodexResult, storage);

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-incremental-'));
    sessionsDirectory = path.join(home, '.codex', 'sessions', '2026');
    mkdirSync(sessionsDirectory, { recursive: true });
    storage = createLocalHistoryStorage(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('emits one row for a session id two rollouts share, the copy the store kept', async () => {
    writeRollout('rollout-a-first.jsonl', rollout({ id: 'shared', minute: 1, skill: 'alpha', total: 900 }));
    writeRollout('rollout-b-resumed.jsonl', rollout({ id: 'shared', minute: 5, skill: 'beta', total: 100 }));
    writeRollout('rollout-c-other.jsonl', rollout({ id: 'other', minute: 3, skill: 'alpha', total: 50 }));

    const first = await fullCollection();
    const second = await fullCollection();

    expect(first.rows.map((row) => row.source?.sourceSessionId).sort()).toEqual(['other', 'shared']);
    // The later rollout in session order is the one an import of both copies left in the store.
    expect(first.rows.find((row) => row.source?.sourceSessionId === 'shared')?.tokIn).toBe(90);
    expect(second.rows).toEqual(first.rows);
  });

  test('returns the full collection on a complete pass and nothing new on an unchanged one', async () => {
    writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 100 }));
    writeRollout('rollout-two.jsonl', rollout({ id: 'two', minute: 2, skill: 'beta', total: 200 }));
    const collect = createCodexIncrementalCollector();

    const complete = await run(collect({ complete: true }), storage);
    const full = await fullCollection();
    expect(complete).toEqual(full);
    expect(observationKeys(complete)).toEqual(['one:exposed:alpha', 'two:exposed:beta']);

    const unchanged = await run(collect({ complete: false }), storage);
    expect(unchanged.observationScope).toBe('changed');
    expect(unchanged.observations).toEqual([]);
    expect(comparable(unchanged)).toEqual(comparable(full));
  });

  test('re-reads one changed rollout and returns only its observations', async () => {
    writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 100 }));
    writeRollout('rollout-two.jsonl', rollout({ id: 'two', minute: 2, skill: 'beta', total: 200 }));
    const collect = createCodexIncrementalCollector();
    await run(collect({ complete: true }), storage);

    writeRollout('rollout-two.jsonl', rollout({ id: 'two', minute: 2, skill: 'gamma', total: 500 }));
    const changed = await run(collect({ complete: false }), storage);
    const full = await fullCollection();

    expect(comparable(changed)).toEqual(comparable(full));
    expect(changed.rows.find((row) => row.source?.sourceSessionId === 'two')?.tokIn).toBe(490);
    expect(observationKeys(changed)).toEqual(['two:exposed:gamma']);
  });

  test('matches a full collection after rollouts are added, rewritten and deleted over several passes', async () => {
    writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 100 }));
    writeRollout('rollout-two.jsonl', rollout({ id: 'two', minute: 2, skill: 'beta', total: 200 }));
    const collect = createCodexIncrementalCollector();
    await run(collect({ complete: true }), storage);

    const steps: (() => void)[] = [
      () => writeRollout('rollout-three.jsonl', rollout({ id: 'three', minute: 3, skill: 'alpha', total: 300 })),
      () => writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 150 })),
      () => rmSync(path.join(sessionsDirectory, 'rollout-two.jsonl')),
      () => undefined,
      () => writeRollout('rollout-three.jsonl', rollout({ id: 'three', minute: 3, skill: 'delta', total: 900 })),
    ];
    for (const step of steps) {
      step();
      const incremental = await run(collect({ complete: false }), storage);
      expect(comparable(incremental)).toEqual(comparable(await fullCollection()));
    }

    const final = await run(collect({ complete: false }), storage);
    expect(final.rows.map((row) => row.source?.sourceSessionId).sort()).toEqual(['one', 'three']);
    // A complete pass still returns every observation, whatever earlier passes left out.
    const complete = await run(collect({ complete: true }), storage);
    expect(complete).toEqual(await fullCollection());
    expect(observationKeys(complete)).toEqual(['one:exposed:alpha', 'three:exposed:delta']);
  });

  test('re-reads a rollout whose stat changed, and drops the entry of a deleted one from the cache', async () => {
    const onePath = writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 100 }));
    writeRollout('rollout-two.jsonl', rollout({ id: 'two', minute: 2, skill: 'beta', total: 200 }));
    const collect = createCodexIncrementalCollector();
    await run(collect({ complete: true }), storage);

    // Same bytes, new mtime: the stat key no longer matches, so the rollout is read again.
    stamp += 10;
    utimesSync(onePath, stamp, stamp);
    const touched = await run(collect({ complete: false }), storage);
    expect(observationKeys(touched)).toEqual(['one:exposed:alpha']);

    rmSync(path.join(sessionsDirectory, 'rollout-two.jsonl'));
    const afterDelete = await run(collect({ complete: false }), storage);
    expect(afterDelete.rows.map((row) => row.source?.sourceSessionId)).toEqual(['one']);
    const cache = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'), {
      readonly: true,
    });
    try {
      const cached = cache.query('SELECT file_path FROM codex_session_cache').all() as { file_path: string }[];
      expect(cached.map((row) => path.basename(row.file_path))).toEqual(['rollout-one.jsonl']);
    } finally {
      cache.close();
    }
  });

  test('returns the observations of every rollout sharing the id of a changed one', async () => {
    writeRollout('rollout-a-first.jsonl', rollout({ id: 'shared', minute: 1, skill: 'alpha', total: 900 }));
    writeRollout('rollout-b-resumed.jsonl', rollout({ id: 'shared', minute: 5, skill: 'beta', total: 100 }));
    const collect = createCodexIncrementalCollector();
    await run(collect({ complete: true }), storage);

    writeRollout('rollout-b-resumed.jsonl', rollout({ id: 'shared', minute: 5, skill: 'gamma', total: 120 }));
    const changed = await run(collect({ complete: false }), storage);
    const full = await fullCollection();

    expect(comparable(changed)).toEqual(comparable(full));
    // Both copies' observations, deduplicated in the same order as a full pass.
    expect(changed.observations).toEqual(full.observations);
  });

  test('keeps a separate index per collector', async () => {
    writeRollout('rollout-one.jsonl', rollout({ id: 'one', minute: 1, skill: 'alpha', total: 100 }));
    const first = createCodexIncrementalCollector();
    await run(first({ complete: true }), storage);

    // A collector that never completed a pass has no index to answer from: it returns everything.
    const second = createCodexIncrementalCollector();
    const cold = await run(second({ complete: false }), storage);
    expect(cold.observationScope).toBeUndefined();
    expect(observationKeys(cold)).toEqual(['one:exposed:alpha']);
  });

  test('retries a state database whose identity moved while it was opened', async () => {
    writeRollout(
      'rollout-meta.jsonl',
      jsonl(
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'meta-thread' } },
        tokenCount('2026-01-01T00:01:00.000Z', 100),
      ),
    );
    const stateDbPath = path.join(home, '.codex', 'state_5.sqlite');
    const state = new Database(stateDbPath);
    state.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT, title TEXT, first_user_message TEXT, source TEXT,
        thread_source TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads (id, cwd, thread_source, model) VALUES ('meta-thread', '/work/from-state', 'user', 'gpt-5.2');
    `);
    state.close();

    let failuresLeft = 2;
    let opens = 0;
    const flaky: LocalHistoryStorageService = {
      ...storage,
      openDatabase: (dbPath) => {
        opens++;
        if (failuresLeft > 0) {
          failuresLeft--;
          return Effect.fail(
            new LocalHistoryError({
              cause: new Error('SQLite history identity changed while opening.'),
              operation: 'sqlite.identityChanged',
              path: `${dbPath}-wal`,
            }),
          );
        }
        return storage.openDatabase(dbPath);
      },
    };

    const result = await run(collectCodexResult, flaky);

    expect(opens).toBe(3);
    // The project comes from the state database: a pass that gave up would have left it empty.
    expect(result.rows[0]?.project).toBe('from-state');
    expect(result.rows[0]?.origin).toBe('human');
  });
});
