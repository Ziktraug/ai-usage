import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import {
  WORK_THREAD_BOUNDS,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
} from '@ai-usage/report-core/work-thread';
import type { WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { applyWorkThreadCommand, seedWorkThreads } from './index';
import {
  countWorkThreads,
  queryUsageStoreGenerations,
  queryWorkThreadById,
  queryWorkThreadEvents,
  queryWorkThreadLinks,
  queryWorkThreadProjects,
  queryWorkThreadsPage,
} from './reader';
import type { WorkThreadSeed } from './work-thread-store';
import { importLocalRows, importPullRequestObservations, initializeUsageStore, recordWorkFactRun } from './writer';

const roots: string[] = [];
const NOW = parseCanonicalInstant('2026-10-24T10:00:00.000Z');
const LATER = parseCanonicalInstant('2026-10-24T11:00:00.000Z');
const MACHINE = 'thread-machine';
const SESSION = `session:${MACHINE}/codex/session-one`;
const PR = 'github.com/fixture/repo#42';
const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-work-threads-'));
  roots.push(root);
  const dbPath = path.join(root, 'usage.sqlite');
  await run(initializeUsageStore({ dbPath }));
  return dbPath;
};

const command = (dbPath: string, input: WorkThreadCommand, now: string = NOW): Promise<WorkThreadCommandResult> =>
  run(applyWorkThreadCommand({ command: input, dbPath, machineId: MACHINE, now }));

const createCommand = (
  overrides: Partial<Extract<WorkThreadCommand, { op: 'create' }>> = {},
): Extract<WorkThreadCommand, { op: 'create' }> => ({
  commandId: randomUUID(),
  intent: 'change',
  links: [],
  objective: 'Deliver the change',
  op: 'create',
  projectLabel: 'fixture',
  title: 'A durable thread',
  ...overrides,
});

const create = async (
  dbPath: string,
  overrides: Partial<Extract<WorkThreadCommand, { op: 'create' }>> = {},
  now = NOW,
): Promise<string> => {
  const result = await command(dbPath, createCommand(overrides), now);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.threadId;
};

const follow = (
  threadId: string,
  expectedRevision: number,
  to: 'following' | 'waiting' | 'done',
  overrides: Partial<Extract<WorkThreadCommand, { op: 'set-follow-state' }>> = {},
): Extract<WorkThreadCommand, { op: 'set-follow-state' }> => ({
  acknowledgedRemainders: [],
  commandId: randomUUID(),
  expectedRevision,
  op: 'set-follow-state',
  reason: null,
  threadId,
  to,
  waitingFor: null,
  waitingOn: null,
  ...overrides,
});

const page = (dbPath: string, query: Partial<WorkThreadListQuery> = {}) =>
  run(
    queryWorkThreadsPage({
      dbPath,
      query: { cursor: null, limit: 50, project: null, search: null, tab: 'open', ...query },
    }),
  );

const seed = (overrides: Partial<WorkThreadSeed> = {}): WorkThreadSeed => ({
  discoveredAt: NOW,
  intent: 'review',
  linkKind: 'pull-request',
  origin: 'pull-request',
  originKey: PR,
  projectLabel: 'fixture',
  title: 'Discovered pull request',
  ...overrides,
});

const threadSnapshot = (dbPath: string): unknown[] => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ['work_threads', 'work_thread_links', 'work_thread_events', 'work_thread_commands'].map((table) =>
      db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  } finally {
    db.close();
  }
};

describe('work thread store', () => {
  test('persists a create and replays its recorded result without a second event', async () => {
    const dbPath = await createStore();
    const input = createCommand({ links: [{ kind: 'session', key: SESSION }] });
    const first = await command(dbPath, input);
    expect(first).toMatchObject({ applied: true, followRevision: 1, ok: true });
    if (!first.ok) {
      throw new Error('Expected a created thread');
    }
    const before = threadSnapshot(dbPath);
    expect(await command(dbPath, { ...input, title: 'A duplicate payload cannot change it' }, LATER)).toEqual({
      ...first,
      applied: false,
    });
    expect(threadSnapshot(dbPath)).toEqual(before);
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.query('SELECT COUNT(*) AS count FROM work_threads').get()).toEqual({ count: 1 });
    reopened.close();
    expect(await run(queryWorkThreadById({ dbPath, threadId: first.threadId }))).toMatchObject({
      followRevision: 1,
      followState: 'following',
      machineId: MACHINE,
      origin: 'user',
      originKey: null,
      title: input.title,
    });
    expect(await run(queryWorkThreadEvents({ dbPath, threadId: first.threadId }))).toHaveLength(1);
  });

  test('two tabs serialize their revision decision and failure replay keeps its original revision', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath);
    const winner = follow(threadId, 1, 'waiting');
    const loser = follow(threadId, 1, 'done');
    const results = await Promise.all([command(dbPath, winner), command(dbPath, loser)]);
    expect(results[0]).toMatchObject({ applied: true, followRevision: 2, ok: true });
    expect(results[1]).toMatchObject({ currentRevision: 2, failure: 'revision-conflict', ok: false });
    await command(dbPath, follow(threadId, 2, 'done'), LATER);
    expect(await command(dbPath, loser)).toEqual(results[1]);
    expect(await command(dbPath, winner)).toEqual({ applied: false, followRevision: 2, ok: true, threadId });
    expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toHaveLength(3);
  });

  test('waiting, done and reopen preserve operator evidence and clear state-specific fields', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath);
    const waitingOn = { kind: 'pull-request-review' as const, linkKey: PR, since: parseCanonicalInstant(NOW) };
    await command(dbPath, follow(threadId, 1, 'waiting', { waitingFor: 'Review', waitingOn }));
    expect(await run(queryWorkThreadById({ dbPath, threadId }))).toMatchObject({ waitingFor: 'Review', waitingOn });
    const done = follow(threadId, 2, 'done', {
      acknowledgedRemainders: ['A local checkout is dirty'],
      reason: 'Delivered',
    });
    await command(dbPath, done, '2026-10-24T13:00:00+02:00');
    expect(await run(queryWorkThreadById({ dbPath, threadId }))).toMatchObject({
      doneAt: LATER,
      doneReason: 'Delivered',
      followRevision: 3,
      followState: 'done',
      waitingFor: null,
      waitingOn: null,
    });
    const beforeInvalid = await run(queryWorkThreadEvents({ dbPath, threadId }));
    expect(await command(dbPath, follow(threadId, 3, 'done'))).toMatchObject({
      failure: 'invalid-transition',
      ok: false,
    });
    expect(await command(dbPath, follow(threadId, 3, 'waiting'))).toMatchObject({
      failure: 'invalid-transition',
      ok: false,
    });
    expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toEqual(beforeInvalid);
    await command(dbPath, follow(threadId, 3, 'following', { reason: 'Undo done' }), '2026-10-24T12:00:00.000Z');
    expect(await run(queryWorkThreadById({ dbPath, threadId }))).toMatchObject({
      doneAt: null,
      doneReason: null,
      followRevision: 4,
      followState: 'following',
      waitingFor: null,
      waitingOn: null,
    });
    expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toMatchObject([
      { kind: 'created' },
      { fromState: 'following', kind: 'follow-state', toState: 'waiting' },
      {
        acknowledgedRemainders: ['A local checkout is dirty'],
        fromState: 'waiting',
        reason: 'Delivered',
        toState: 'done',
      },
      { fromState: 'done', reason: 'Undo done', toState: 'following' },
    ]);
  });

  test('detaches without deleting, relinks with new identity, and shares a session between threads', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, {
      links: [
        { key: SESSION, kind: 'session' },
        { key: SESSION, kind: 'session' },
      ],
    });
    const second = await create(dbPath, { links: [{ key: SESSION, kind: 'session' }] });
    const link = (await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] })))[0];
    expect(link).toBeDefined();
    if (!link) {
      throw new Error('Expected original link');
    }
    expect(
      await command(dbPath, { commandId: randomUUID(), key: SESSION, kind: 'session', op: 'link', threadId }),
    ).toMatchObject({ applied: false, ok: true });
    expect(
      await command(dbPath, { commandId: randomUUID(), linkId: link.linkId, op: 'detach-link', threadId: second }),
    ).toMatchObject({ failure: 'invalid-link', ok: false });
    await command(dbPath, { commandId: randomUUID(), linkId: link.linkId, op: 'detach-link', threadId }, LATER);
    expect(
      await command(dbPath, { commandId: randomUUID(), linkId: link.linkId, op: 'detach-link', threadId }),
    ).toMatchObject({ applied: false, ok: true });
    await command(dbPath, { commandId: randomUUID(), key: SESSION, kind: 'session', op: 'link', threadId }, LATER);
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId, second] }));
    expect(links).toHaveLength(3);
    expect(links.find((item) => item.linkId === link.linkId)?.detachedAt).toBe(LATER);
    expect(links.filter((item) => item.detachedAt === null)).toHaveLength(2);
    expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toHaveLength(3);
  });

  test('rejects malformed links and enforces the active link bound while detached history remains', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, {
      links: Array.from({ length: WORK_THREAD_BOUNDS.maxLinksPerThread }, (_, index) => ({
        key: `session:${MACHINE}/codex/${index}`,
        kind: 'session',
      })),
    });
    const invalid = {
      commandId: randomUUID(),
      key: 'unqualified',
      kind: 'session' as const,
      op: 'link' as const,
      threadId,
    };
    expect(await command(dbPath, invalid)).toMatchObject({ failure: 'invalid-link', ok: false });
    expect(await command(dbPath, invalid)).toMatchObject({ failure: 'invalid-link', ok: false });
    const extra = { commandId: randomUUID(), key: SESSION, kind: 'session' as const, op: 'link' as const, threadId };
    expect(await command(dbPath, extra)).toMatchObject({ failure: 'invalid-link', ok: false });
    const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    if (!link) {
      throw new Error('Expected original link');
    }
    await command(dbPath, { commandId: randomUUID(), linkId: link.linkId, op: 'detach-link', threadId });
    // The failed command remains failed; a new intent has a new command id.
    expect(await command(dbPath, extra)).toMatchObject({ failure: 'invalid-link', ok: false });
    expect(await command(dbPath, { ...extra, commandId: randomUUID() })).toMatchObject({ applied: true, ok: true });
    expect(await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }))).toHaveLength(65);
  });

  test('rename and note commands are durable and leave the follow revision unchanged', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath);
    const rename: WorkThreadCommand = { commandId: randomUUID(), op: 'rename', threadId, title: 'New title' };
    const note: WorkThreadCommand = {
      commandId: randomUUID(),
      note: 'Remember the evidence',
      op: 'set-note',
      threadId,
    };
    expect(await command(dbPath, rename, LATER)).toMatchObject({ applied: true, followRevision: 1 });
    expect(await command(dbPath, note, LATER)).toMatchObject({ applied: true, followRevision: 1 });
    expect(await command(dbPath, { ...note, commandId: randomUUID() })).toMatchObject({ applied: false });
    expect(await command(dbPath, { ...rename, commandId: randomUUID() })).toMatchObject({ applied: false });
    expect(await run(queryWorkThreadById({ dbPath, threadId }))).toMatchObject({
      note: note.note,
      title: rename.title,
    });
    expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toMatchObject([
      { kind: 'created' },
      { kind: 'renamed' },
      { kind: 'note' },
    ]);
  });

  test('three seed runs preserve done state and never resurrect a detached origin link', async () => {
    const dbPath = await createStore();
    const input = { dbPath, machineId: MACHINE, now: NOW, seeds: [seed(), seed()] };
    expect(await run(seedWorkThreads(input))).toEqual({ created: 1, existing: 1 });
    const first = (await page(dbPath)).rows[0]?.thread;
    if (!first) {
      throw new Error('Expected seed thread');
    }
    const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [first.threadId] }));
    if (!link) {
      throw new Error('Expected seed origin link');
    }
    expect(link.provenance).toBe('origin');
    await command(dbPath, follow(first.threadId, 1, 'done', { reason: 'Already handled' }));
    await command(dbPath, {
      commandId: randomUUID(),
      linkId: link.linkId,
      op: 'detach-link',
      threadId: first.threadId,
    });
    const before = threadSnapshot(dbPath);
    expect(await run(seedWorkThreads({ ...input, now: LATER }))).toEqual({ created: 0, existing: 2 });
    expect(await run(seedWorkThreads({ ...input, now: LATER }))).toEqual({ created: 0, existing: 2 });
    expect(threadSnapshot(dbPath)).toEqual(before);
    expect(await run(countWorkThreads({ dbPath }))).toEqual({ done: 1, open: 0 });
  });

  test('seed validation rolls back the complete batch and canonicalizes discovered instants', async () => {
    const dbPath = await createStore();
    const failed = await Effect.runPromise(
      Effect.either(
        seedWorkThreads({
          dbPath,
          machineId: MACHINE,
          now: NOW,
          seeds: [seed(), seed({ originKey: 'not-a-qualified-key' })],
        }),
      ),
    );
    expect(failed._tag).toBe('Left');
    expect(await run(countWorkThreads({ dbPath }))).toEqual({ done: 0, open: 0 });
    await run(
      seedWorkThreads({
        dbPath,
        machineId: MACHINE,
        now: NOW,
        seeds: [seed({ discoveredAt: '2026-10-24T11:00:00+02:00' })],
      }),
    );
    expect((await page(dbPath)).rows[0]?.thread.createdAt).toBe(parseCanonicalInstant('2026-10-24T09:00:00.000Z'));
  });

  test('SQL scope precedes pagination and searches active qualified keys with literal punctuation', async () => {
    const dbPath = await createStore();
    const old = await create(dbPath, {
      title: 'Old waiting work',
      projectLabel: 'old-project',
      links: [{ kind: 'branch', key: 'branch:github.com/fixture/repo@fix/a_b%' }],
    });
    await command(dbPath, follow(old, 1, 'waiting'));
    await run(
      seedWorkThreads({
        dbPath,
        machineId: MACHINE,
        now: LATER,
        seeds: Array.from({ length: 120 }, (_, index) =>
          seed({
            originKey: `github.com/fixture/repo#${index + 100}`,
            projectLabel: 'busy-project',
            title: `New ${index}`,
          }),
        ),
      }),
    );
    expect((await page(dbPath, { limit: 1, project: 'old-project' })).rows.map((row) => row.thread.threadId)).toEqual([
      old,
    ]);
    expect((await page(dbPath, { limit: 1, search: 'WAITING' })).rows.map((row) => row.thread.threadId)).toEqual([old]);
    expect((await page(dbPath, { limit: 1, search: 'a_b%' })).rows.map((row) => row.thread.threadId)).toEqual([old]);
    const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [old] }));
    if (!link) {
      throw new Error('Expected branch link');
    }
    await command(dbPath, { commandId: randomUUID(), linkId: link.linkId, op: 'detach-link', threadId: old });
    expect((await page(dbPath, { search: 'a_b%' })).rows).toEqual([]);
    expect(await run(queryWorkThreadProjects({ dbPath }))).toEqual(['busy-project', 'old-project']);
  });

  test('keyset cursors visit tied instants once, reject changed scope, and keep activity monotonic', async () => {
    const dbPath = await createStore();
    const ids = [await create(dbPath), await create(dbPath), await create(dbPath)];
    const first = await page(dbPath, { limit: 1 });
    const second = await page(dbPath, { cursor: first.nextCursor, limit: 1 });
    const third = await page(dbPath, { cursor: second.nextCursor, limit: 1 });
    expect([first, second, third].flatMap((result) => result.rows.map((row) => row.thread.threadId))).toEqual(
      ids.toSorted(),
    );
    expect(third.nextCursor).toBeNull();
    const invalid = await Effect.runPromise(
      Effect.either(
        queryWorkThreadsPage({
          dbPath,
          query: { cursor: first.nextCursor, limit: 1, project: 'other', search: null, tab: 'open' },
        }),
      ),
    );
    expect(invalid._tag).toBe('Left');
    const id = ids[0];
    if (!id) {
      throw new Error('Expected thread');
    }
    await command(
      dbPath,
      { commandId: randomUUID(), note: 'Later instant', op: 'set-note', threadId: id },
      '2026-10-24T12:30:00+02:00',
    );
    await command(
      dbPath,
      { commandId: randomUUID(), note: 'Clock moved backwards', op: 'set-note', threadId: id },
      NOW,
    );
    expect((await page(dbPath, { limit: 1 })).rows[0]).toMatchObject({
      lastActivityAt: '2026-10-24T10:30:00.000Z',
      thread: { threadId: id },
    });
  });

  test('commands and seeds do not advance report generations or write replication events', async () => {
    const dbPath = await createStore();
    const before = await run(queryUsageStoreGenerations({ dbPath }));
    const db = new Database(dbPath, { readonly: true });
    const outbox = db.query('SELECT * FROM replication_outbox_events').all();
    db.close();
    const threadId = await create(dbPath);
    await command(dbPath, follow(threadId, 1, 'done'));
    await run(seedWorkThreads({ dbPath, machineId: MACHINE, now: NOW, seeds: [seed()] }));
    expect(await run(queryUsageStoreGenerations({ dbPath }))).toEqual(before);
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.query('SELECT * FROM replication_outbox_events').all()).toEqual(outbox);
    reopened.close();
  });

  test('a collection imports usage and work facts without changing durable threads', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, { links: [{ key: PR, kind: 'pull-request' }] });
    await command(dbPath, follow(threadId, 1, 'done', { reason: 'Operator decision' }));
    const before = threadSnapshot(dbPath);
    await run(
      importLocalRows({
        dbPath,
        machine: { id: MACHINE, label: 'Thread fixture' },
        rows: [
          normalizeUsageRow({
            calls: 1,
            cost: actualCost(null),
            date: new Date(LATER),
            durationMs: 1000,
            endDate: new Date('2026-10-24T11:01:00.000Z'),
            harness: 'Codex',
            model: 'fixture-model',
            name: 'Further session activity',
            project: 'fixture',
            provider: 'OpenAI',
            tokens: { cr: 0, cw: 0, in: 10, out: 20 },
          }),
        ],
      }),
    );
    await run(
      importPullRequestObservations({
        dbPath,
        observations: [
          {
            accountLabel: null,
            baseRef: 'main',
            checksRollup: 'success',
            draft: false,
            headRef: 'topic',
            host: 'github.com',
            machineId: MACHINE,
            mergedAt: null,
            number: 42,
            observedAt: LATER,
            outcome: 'observed',
            outcomeMessage: null,
            repository: 'fixture/repo',
            reviewDecision: 'REVIEW_REQUIRED',
            state: 'OPEN',
            title: 'Work continues',
            updatedAt: LATER,
            url: 'https://github.com/fixture/repo/pull/42',
          },
        ],
      }),
    );
    await run(
      recordWorkFactRun({
        dbPath,
        disabled: false,
        failed: 0,
        machineId: MACHINE,
        message: null,
        observed: 1,
        ranAt: new Date(LATER),
        sourceId: 'github.pull-requests',
      }),
    );
    expect(threadSnapshot(dbPath)).toEqual(before);
  });

  test('stored corruption fails visibly rather than disappearing from reads', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath);
    const db = new Database(dbPath);
    db.query('UPDATE work_threads SET title = ? WHERE thread_id = ?').run('', threadId);
    db.close();
    const result = await Effect.runPromise(Effect.either(queryWorkThreadById({ dbPath, threadId })));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.reason).toBe('corrupt');
    }
  });

  test('readers do not create missing thread tables', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath);
    db.exec(
      'DROP TABLE work_thread_commands; DROP TABLE work_thread_events; DROP TABLE work_thread_links; DROP TABLE work_threads',
    );
    db.close();
    const result = await Effect.runPromise(Effect.either(countWorkThreads({ dbPath })));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.reason).toBe('schema-too-old');
    }
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.query("SELECT name FROM sqlite_schema WHERE name = 'work_threads'").get()).toBeNull();
    reopened.close();
  });
});
