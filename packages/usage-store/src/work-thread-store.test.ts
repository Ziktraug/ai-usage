import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import type { JiraIssueObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import {
  WORK_THREAD_BOUNDS,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadLink,
} from '@ai-usage/report-core/work-thread';
import type { WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import { UsageStoreError } from './errors';
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
import { createWorkThreadStore, type WorkThreadSeed, workThreadSchemaSql } from './work-thread-store';
import {
  applyWorkThreadWaitObservations,
  attachDeclaredWorkThreadSessions,
  importJiraIssueObservations,
  importLocalRows,
  importPullRequestObservations,
  initializeUsageStore,
  queryActiveWorkThreadLinks,
  queryWorkThreadWaitCandidates,
  recordWorkFactRun,
} from './writer';

const roots: string[] = [];
const NOW = parseCanonicalInstant('2026-10-24T10:00:00.000Z');
const LATER = parseCanonicalInstant('2026-10-24T11:00:00.000Z');
const MACHINE = 'thread-machine';
const SESSION = `session:${MACHINE}/codex/session-one`;
const PR = 'github.com/fixture/repo#42';
const run = <Value>(effect: Effect.Effect<Value, UsageStoreError>): Promise<Value> => Effect.runPromise(effect);

describe('declared sessions join existing Work threads', () => {
  test('links exact declarations to each active PR thread once, including Done, without seeding', async () => {
    const dbPath = await createStore();
    const first = await create(dbPath, { links: [{ kind: 'pull-request', key: PR }] });
    const second = await create(dbPath, { links: [{ kind: 'pull-request', key: 'github.com/fixture/repo#43' }] });
    await command(dbPath, follow(second, 1, 'done'));
    const input = {
      dbPath,
      machineId: MACHINE,
      now: LATER,
      declarations: [
        { pullRequestKey: 'GitHub.COM/Fixture/Repo#42', sessionKey: SESSION },
        { pullRequestKey: PR, sessionKey: SESSION },
        { pullRequestKey: 'github.com/fixture/repo#43', sessionKey: SESSION },
        { pullRequestKey: 'github.com/fixture/repo#999', sessionKey: `session:${MACHINE}/claude/unmatched` },
      ],
    };
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 2,
      existing: 0,
      detached: 0,
      truncated: false,
    });
    const snapshot = threadSnapshot(dbPath);
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 0,
      existing: 2,
      detached: 0,
      truncated: false,
    });
    expect(threadSnapshot(dbPath)).toEqual(snapshot);
    expect(await run(countWorkThreads({ dbPath }))).toEqual({ open: 1, done: 1 });
    for (const threadId of [first, second]) {
      const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
      expect(links.filter(({ kind }) => kind === 'session')).toMatchObject([
        { key: SESSION, provenance: 'declared', createdAt: LATER },
      ]);
      expect(
        (await run(queryWorkThreadEvents({ dbPath, threadId }))).filter(({ kind }) => kind === 'link-added'),
      ).toHaveLength(1);
    }
  });

  test('preserves detached session and PR links and refuses foreign session identities atomically', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, {
      links: [
        { kind: 'pull-request', key: PR },
        { kind: 'session', key: SESSION },
      ],
    });
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    const session = links.find(({ kind }) => kind === 'session');
    if (!session) {
      throw new Error('Missing session fixture');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: session.linkId });
    const input = {
      dbPath,
      machineId: MACHINE,
      now: LATER,
      declarations: [{ pullRequestKey: PR, sessionKey: SESSION }],
    };
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 0,
      existing: 0,
      detached: 1,
      truncated: false,
    });
    const before = threadSnapshot(dbPath);
    const failure = await Effect.runPromise(
      attachDeclaredWorkThreadSessions({
        ...input,
        declarations: [
          { pullRequestKey: PR, sessionKey: `session:${MACHINE}/claude/new` },
          { pullRequestKey: PR, sessionKey: 'session:foreign/codex/session' },
        ],
      }).pipe(Effect.flip),
    );
    expect(failure.reason).toBe('invalid-input');
    expect(threadSnapshot(dbPath)).toEqual(before);
    const pr = links.find(({ kind }) => kind === 'pull-request');
    if (!pr) {
      throw new Error('Missing PR fixture');
    }
    await command(dbPath, { commandId: randomUUID(), op: 'detach-link', threadId, linkId: pr.linkId });
    expect(
      await run(
        attachDeclaredWorkThreadSessions({
          ...input,
          declarations: [{ pullRequestKey: PR, sessionKey: `session:${MACHINE}/claude/new` }],
        }),
      ),
    ).toEqual({ linked: 0, existing: 0, detached: 0, truncated: false });
  });

  test('reports full threads and the declaration bound without exceeding active link capacity', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, {
      links: [
        { kind: 'pull-request', key: PR },
        ...Array.from({ length: 63 }, (_, i) => ({
          kind: 'session' as const,
          key: `session:${MACHINE}/codex/existing-${i}`,
        })),
      ],
    });
    const result = await run(
      attachDeclaredWorkThreadSessions({
        dbPath,
        machineId: MACHINE,
        now: LATER,
        declarations: Array.from({ length: 501 }, (_, i) => ({
          pullRequestKey: PR,
          sessionKey: `session:${MACHINE}/codex/new-${i}`,
        })),
      }),
    );
    expect(result).toEqual({ linked: 0, existing: 0, detached: 0, truncated: true });
    expect(await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }))).toHaveLength(64);
  });

  test('continues a bounded attachment batch past already-linked threads on the next run', async () => {
    const dbPath = await createStore();
    const first = await create(dbPath, { links: [{ kind: 'pull-request', key: PR }] });
    const db = new Database(dbPath);
    try {
      for (let i = 0; i < 500; i++) {
        const threadId = randomUUID();
        db.query(
          'INSERT INTO work_threads SELECT ?, machine_id, title, objective, project_label, intent, origin, origin_key, follow_state, follow_revision, waiting_for, waiting_on_json, done_at, done_reason, note, created_at, updated_at, last_activity_at FROM work_threads WHERE thread_id = ?',
        ).run(threadId, first);
        db.query(`INSERT INTO work_thread_links VALUES (?, ?, 'pull-request', ?, 'declared', ?, NULL)`).run(
          randomUUID(),
          threadId,
          PR,
          NOW,
        );
      }
    } finally {
      db.close();
    }
    const input = {
      dbPath,
      machineId: MACHINE,
      now: LATER,
      declarations: [{ pullRequestKey: PR, sessionKey: SESSION }],
    };
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 500,
      existing: 0,
      detached: 0,
      truncated: true,
    });
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 1,
      existing: 500,
      detached: 0,
      truncated: false,
    });
    expect(await run(attachDeclaredWorkThreadSessions(input))).toEqual({
      linked: 0,
      existing: 501,
      detached: 0,
      truncated: false,
    });
  });
});

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

/** Real disposable SQLite, reduced served columns, and counted query-only connection ownership. */
const evidenceFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-thread-evidence-'));
  roots.push(root);
  const dbPath = path.join(root, 'evidence.sqlite');
  const db = new Database(dbPath);
  db.exec(workThreadSchemaSql);
  db.exec(`
    CREATE TABLE served_report_current(singleton INTEGER, revision TEXT);
    CREATE TABLE served_report_revisions(revision TEXT, generated_at TEXT, complete INTEGER);
    CREATE TABLE served_report_rows(revision TEXT, ordinal INTEGER, row_id TEXT, project_label TEXT,
      campaign_root INTEGER, origin TEXT, active_time INTEGER, machine_id TEXT, source_row_json TEXT);
    CREATE TABLE claude_desktop_sessions(id INTEGER PRIMARY KEY, machine_id TEXT, desktop_session_id TEXT,
      cli_session_id TEXT, prior_cli_session_ids_json TEXT, title TEXT, created_at TEXT, last_activity_at TEXT,
      cwd TEXT, worktree_path TEXT, last_turn_report TEXT, status_category TEXT, needs_action TEXT,
      status_detail TEXT, spawned_from_session_id TEXT, observed_at TEXT, branch TEXT);
    INSERT INTO served_report_current VALUES (1, 'fixture');
  `);
  db.query('INSERT INTO served_report_revisions VALUES (?, ?, 1)').run('fixture', NOW);
  let connections = 0;
  let queries = 0;
  const store = createWorkThreadStore({
    usageStoreError: (operation, _path, cause, reason) =>
      new UsageStoreError({ operation, message: String(cause), reason }),
    usageStoreReadError: (operation, _path, cause) =>
      cause instanceof UsageStoreError
        ? cause
        : new UsageStoreError({ operation, message: String(cause), reason: 'storage-failure' }),
    withUsageStoreReader: (_path, use) =>
      Effect.suspend(() => {
        connections++;
        const reader = new Database(dbPath, { readonly: true });
        reader.exec('PRAGMA query_only = ON');
        return use({
          exec: (sql) => reader.exec(sql),
          query: (sql) => {
            queries++;
            return reader.query(sql) as unknown as ReturnType<Parameters<typeof use>[0]['query']>;
          },
        }).pipe(Effect.ensuring(Effect.sync(() => reader.close())));
      }),
    withUsageStoreWriter: (_path, use) => use(db as unknown as Parameters<typeof use>[0]),
  });
  let ordinal = 0;
  const addSession = (
    id: string,
    title: string,
    options: {
      machine?: string;
      harness?: string;
      parent?: string;
      revision?: string;
      checkout?: string;
      branch?: string;
      repository?: string;
    } = {},
  ) => {
    ordinal++;
    db.query('INSERT INTO served_report_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      options.revision ?? 'fixture',
      ordinal,
      `row-${ordinal}`,
      'fixture',
      Number(!options.parent),
      options.parent ? 'subagent' : 'human',
      ordinal,
      options.machine ?? MACHINE,
      JSON.stringify({
        date: NOW,
        endDate: LATER,
        sessionLabel: title,
        source: {
          harnessKey: options.harness ?? 'codex',
          sourceSessionId: id,
          parentSourceSessionId: options.parent ?? null,
          sourcePath: options.checkout ?? '/fixture',
          vcs: options.repository
            ? {
                repository: { host: 'GitHub.COM', ownerPath: options.repository },
                branches: [{ name: options.branch }],
              }
            : undefined,
        },
      }),
    );
  };
  const addDesktop = (id: string, title: string, prior: readonly string[] = [], machine = MACHINE) => {
    db.query(`INSERT INTO claude_desktop_sessions (
      machine_id, desktop_session_id, cli_session_id, prior_cli_session_ids_json, title, created_at,
      last_activity_at, cwd, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      machine,
      `desktop-${id}`,
      id,
      JSON.stringify(prior),
      title,
      NOW,
      LATER,
      '/fixture',
      LATER,
    );
  };
  const createThread = async (links: readonly { kind: 'session'; key: string }[], now = NOW) => {
    const result = await run(
      store.applyWorkThreadCommand({ dbPath, machineId: MACHINE, now, command: createCommand({ links }) }),
    );
    if (!result.ok) {
      throw new Error(result.message);
    }
    return result.threadId;
  };
  return { addSession, addDesktop, createThread, db, dbPath, store, counts: () => ({ connections, queries }) };
};

const evidenceLink = (threadId: string, sessionId: string, harness = 'codex'): WorkThreadLink => ({
  linkId: randomUUID(),
  threadId,
  kind: 'session',
  key: `session:${MACHINE}/${harness}/${sessionId}`,
  provenance: 'user',
  createdAt: NOW,
  detachedAt: null,
});

describe('work thread store', () => {
  test('measures session-title search across 20,000 served rows and 500 threads', async () => {
    const { db, dbPath, store, addSession, createThread } = await evidenceFixture();
    try {
      db.transaction(() => {
        for (let index = 0; index < 20_000; index++) {
          addSession(`benchmark-${index}`, index % 5 === 0 ? 'Needle session title' : 'Unrelated session');
        }
      })();
      for (let index = 0; index < 500; index++) {
        await createThread(
          Array.from({ length: 5 }, (_, link) => ({
            kind: 'session' as const,
            key: `session:${MACHINE}/codex/benchmark-${index * 40 + link}`,
          })),
        );
      }
      const durations: number[] = [];
      for (let index = 0; index < 5; index++) {
        const start = performance.now();
        const result = await run(
          store.queryWorkThreadsPage({
            dbPath,
            query: { cursor: null, limit: 100, project: null, search: 'needle session', tab: 'open' },
          }),
        );
        durations.push(performance.now() - start);
        expect(result.rows).toHaveLength(100);
        expect(result.nextCursor).not.toBeNull();
      }
      console.info(
        `Session-title search 20,000 rows x 500 threads: ${durations.map((ms) => ms.toFixed(1)).join(', ')} ms; median ${durations.toSorted((a, b) => a - b)[2]?.toFixed(1)} ms`,
      );
    } finally {
      db.close();
    }
  }, 120_000);

  test('searches exact linked served and Desktop titles before pagination, excluding detached and other identities', async () => {
    const fixture = await evidenceFixture();
    const { db, dbPath, store, addSession, addDesktop, createThread } = fixture;
    try {
      addSession('served', 'Rare served title');
      addSession('served', 'Other machine title', { machine: 'elsewhere' });
      addSession('served', 'Other harness title', { harness: 'claude' });
      addSession('served', 'Unpublished title', { revision: 'older' });
      addDesktop('current-cli', 'Rare Desktop title', ['prior-cli']);
      addDesktop('current-cli', 'Other Desktop machine title', [], 'elsewhere');
      const served = await createThread([{ kind: 'session', key: `session:${MACHINE}/codex/served` }]);
      const current = await createThread([{ kind: 'session', key: `session:${MACHINE}/claude/current-cli` }]);
      const prior = await createThread([{ kind: 'session', key: `session:${MACHINE}/claude/prior-cli` }]);
      await createThread([{ kind: 'session', key: `session:${MACHINE}/codex/current-cli` }], LATER);
      for (let index = 0; index < 8; index++) {
        await createThread([], LATER);
      }
      const search = (text: string, cursor: string | null = null) =>
        run(
          store.queryWorkThreadsPage({ dbPath, query: { cursor, limit: 1, project: null, search: text, tab: 'open' } }),
        );
      expect((await search('RARE SERVED')).rows.map((row) => row.thread.threadId)).toEqual([served]);
      const desktopFirst = await search('Rare Desktop');
      const desktopSecond = await search('Rare Desktop', desktopFirst.nextCursor);
      expect(
        [desktopFirst, desktopSecond].flatMap((result) => result.rows.map((row) => row.thread.threadId)).toSorted(),
      ).toEqual([current, prior].toSorted());
      expect(desktopSecond.nextCursor).toBeNull();
      for (const wrong of ['Other machine', 'Other harness', 'Unpublished', 'Other Desktop machine']) {
        expect((await search(wrong)).rows).toEqual([]);
      }
      const [link] = await run(store.queryWorkThreadLinks({ dbPath, threadIds: [served] }));
      if (!link) {
        throw new Error('Expected linked served session');
      }
      await run(
        store.applyWorkThreadCommand({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          command: { op: 'detach-link', commandId: randomUUID(), threadId: served, linkId: link.linkId },
        }),
      );
      expect((await search('Rare served')).rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('preserves the native Desktop checkout branch apart from served session history', async () => {
    const { db, dbPath, store, addSession, addDesktop } = await evidenceFixture();
    try {
      addSession('desktop', 'Served Desktop', { harness: 'claude', repository: 'fixture/repo', branch: 'old-branch' });
      addDesktop('desktop', 'Native Desktop');
      db.query('UPDATE claude_desktop_sessions SET branch = ?').run('native-branch');
      const input = { dbPath, machineId: MACHINE, links: [evidenceLink(randomUUID(), 'desktop', 'claude')] };
      const known = await run(store.queryWorkThreadSessionEvidence(input));
      expect(known.sessions[0]?.member.branch).toBe('old-branch');
      expect(known.sessions[0]?.desktop?.branch).toBe('native-branch');
      db.query('UPDATE claude_desktop_sessions SET branch = NULL').run();
      const unknown = await run(store.queryWorkThreadSessionEvidence(input));
      expect(unknown.sessions[0]?.member.branch).toBe('old-branch');
      expect(unknown.sessions[0]?.desktop?.branch).toBeNull();
    } finally {
      db.close();
    }
  });

  test('batches more than 64 session links in one snapshot with independent per-thread and parent bounds', async () => {
    const fixture = await evidenceFixture();
    const { db, dbPath, store, addSession, addDesktop } = fixture;
    try {
      const scopes = Array.from({ length: 3 }, (_, thread) => {
        const threadId = randomUUID();
        return {
          threadId,
          machineId: MACHINE,
          links: Array.from({ length: 32 }, (_session, index) => {
            const id = `thread-${thread}-session-${index}`;
            addSession(id, id);
            return evidenceLink(threadId, id);
          }),
        };
      });
      const first = scopes[0];
      if (!first) {
        throw new Error('Expected evidence scopes');
      }
      addSession('thread-0-session-0', 'wrong machine', { machine: 'elsewhere' });
      addSession('thread-0-session-0', 'wrong harness', { harness: 'claude' });
      for (let index = 0; index < 23; index++) {
        addSession(`child-${index}`, `child-${index}`, { parent: 'thread-0-session-0' });
      }
      addSession('desktop-prior', 'Served Desktop', { harness: 'claude' });
      addDesktop('desktop-current', 'Newest Desktop', ['desktop-prior']);
      first.links.push(evidenceLink(first.threadId, 'desktop-prior', 'claude'));
      const emptyId = randomUUID();
      scopes.push({ threadId: emptyId, machineId: MACHINE, links: [] });
      const before = fixture.counts();
      const results = await run(store.queryWorkThreadSessionEvidence({ dbPath, threads: scopes }));
      expect(fixture.counts().connections - before.connections).toBe(1);
      // One additional bounded native Desktop lookup covers roots absent from the served revision.
      expect(fixture.counts().queries - before.queries).toBeLessThanOrEqual(7);
      expect(results.map((entry) => entry.threadId)).toEqual(scopes.map((scope) => scope.threadId));
      expect(results.map((entry) => entry.evidence.sessions.length)).toEqual([53, 32, 32, 0]);
      expect(results.map((entry) => entry.evidence.truncated)).toEqual([true, false, false, false]);
      expect(
        results[0]?.evidence.sessions.filter((entry) => entry.member.parentSourceSessionId === 'thread-0-session-0'),
      ).toHaveLength(20);
      expect(
        results[0]?.evidence.sessions.find((entry) => entry.member.sourceSessionId === 'desktop-prior')?.desktop?.title,
      ).toBe('Newest Desktop');
      expect(
        results.flatMap((entry) => entry.evidence.sessions).some((entry) => entry.member.title.startsWith('wrong')),
      ).toBe(false);
      expect(results[1]?.evidence.sessions.every((entry) => entry.member.sourceSessionId.startsWith('thread-1-'))).toBe(
        true,
      );
      expect(results.every((entry) => entry.evidence.revision === 'fixture')).toBe(true);
      expect(await run(store.queryWorkThreadSessionEvidence({ dbPath, threads: [] }))).toEqual([]);
      const tooMany = Array.from({ length: 65 }, (_, index) => evidenceLink(first.threadId, `extra-${index}`));
      const invalid = await Effect.runPromise(
        Effect.result(store.queryWorkThreadSessionEvidence({ dbPath, threads: [{ ...first, links: tooMany }] })),
      );
      expect(invalid._tag).toBe('Failure');
      if (invalid._tag === 'Failure') {
        expect(invalid.failure.reason).toBe('invalid-input');
      }
      const crossThread = await Effect.runPromise(
        Effect.result(
          store.queryWorkThreadSessionEvidence({
            dbPath,
            threads: [{ ...first, links: [evidenceLink(emptyId, 'thread-0-session-0')] }],
          }),
        ),
      );
      expect(crossThread._tag).toBe('Failure');
    } finally {
      db.close();
    }
  });

  test('excludes detached children before the per-parent bound independently per thread and permits relinks', async () => {
    const { db, dbPath, store, addSession, createThread } = await evidenceFixture();
    try {
      addSession('parent', 'Root');
      for (let index = 0; index < 21; index++) {
        addSession(`child-${index}`, `Child ${index}`, { parent: 'parent' });
      }
      const first = await createThread([
        { kind: 'session', key: `session:${MACHINE}/codex/parent` },
        { kind: 'session', key: `session:${MACHINE}/codex/child-20` },
      ]);
      const second = await createThread([{ kind: 'session', key: `session:${MACHINE}/codex/parent` }]);
      const child = (await run(store.queryWorkThreadLinks({ dbPath, threadIds: [first] }))).find((link) =>
        link.key.endsWith('/child-20'),
      );
      if (!child) {
        throw new Error('Expected child link');
      }
      await run(
        store.applyWorkThreadCommand({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          command: { commandId: randomUUID(), op: 'detach-link', threadId: first, linkId: child.linkId },
        }),
      );
      // Old detach decisions must survive more history than the bounded view returns.
      db.transaction(() => {
        for (let index = 0; index < 300; index++) {
          db.query('INSERT INTO work_thread_links VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            randomUUID(),
            first,
            'session',
            `session:${MACHINE}/codex/old-${index}`,
            'user',
            NOW,
            LATER,
          );
        }
      })();
      const scope = async (threadId: string) => ({
        threadId,
        machineId: MACHINE,
        links: (await run(store.queryWorkThreadLinks({ dbPath, threadIds: [threadId] }))).filter(
          (link) => link.detachedAt === null,
        ),
      });
      const result = await run(
        store.queryWorkThreadSessionEvidence({ dbPath, threads: [await scope(first), await scope(second)] }),
      );
      expect(result[0]?.evidence.sessions).toHaveLength(21);
      expect(result[0]?.evidence.sessions.some((entry) => entry.member.sourceSessionId === 'child-20')).toBe(false);
      expect(result[0]?.evidence.sessions.some((entry) => entry.member.sourceSessionId === 'child-0')).toBe(true);
      expect(result[0]?.evidence.truncated).toBe(false);
      expect(result[1]?.evidence.sessions.some((entry) => entry.member.sourceSessionId === 'child-20')).toBe(true);
      expect(result[1]?.evidence.truncated).toBe(true);
      await run(
        store.applyWorkThreadCommand({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          command: { commandId: randomUUID(), op: 'link', threadId: first, kind: 'session', key: child.key },
        }),
      );
      const relinked = await run(store.queryWorkThreadSessionEvidence({ dbPath, ...(await scope(first)) }));
      expect(relinked.sessions.some((entry) => entry.member.sourceSessionId === 'child-20')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('joins legacy branch authorities without changing ref case or resurrecting detached checkout evidence', async () => {
    const { db, dbPath, store, addSession, createThread } = await evidenceFixture();
    try {
      addSession('branch-session', 'Branch match', {
        repository: 'Fixture/Repo',
        branch: 'Feature',
        checkout: '/matching',
      });
      addSession('other-ref', 'Other ref', { repository: 'fixture/repo', branch: 'feature', checkout: '/other-ref' });
      addSession('detached', 'Detached', { repository: 'Fixture/Repo', branch: 'Feature', checkout: '/detached' });
      const threadId = await createThread([{ kind: 'session', key: `session:${MACHINE}/codex/detached` }]);
      await run(
        store.applyWorkThreadCommand({
          dbPath,
          machineId: MACHINE,
          now: NOW,
          command: {
            op: 'link',
            commandId: randomUUID(),
            threadId,
            kind: 'branch',
            key: 'branch:github.com/Fixture/Repo@Feature',
          },
        }),
      );
      db.query("UPDATE work_thread_links SET link_key = ? WHERE kind = 'branch'").run(
        'branch:GitHub.COM/FIXTURE/REPO@Feature',
      );
      db.query("UPDATE work_thread_links SET detached_at = ? WHERE kind = 'session'").run(LATER);
      const links = (await run(store.queryWorkThreadLinks({ dbPath, threadIds: [threadId] }))).filter(
        (link) => link.detachedAt === null,
      );
      const evidence = await run(store.queryWorkThreadSessionEvidence({ dbPath, links, machineId: MACHINE }));
      expect(evidence.branchCheckouts.map((checkout) => checkout.checkoutPath)).toEqual(['/matching']);
    } finally {
      db.close();
    }
  });

  test('returns bounded distinct active PR and Jira links of non-Done local threads', async () => {
    const { db, dbPath, store } = await evidenceFixture();
    try {
      const add = async (machineId: string, links: Extract<WorkThreadCommand, { op: 'create' }>['links']) => {
        const result = await run(
          store.applyWorkThreadCommand({ dbPath, machineId, now: NOW, command: createCommand({ links }) }),
        );
        if (!result.ok) {
          throw new Error('Expected thread');
        }
        return result.threadId;
      };
      const first = await add(MACHINE, [
        { kind: 'pull-request', key: PR },
        { kind: 'jira-issue', key: 'jira:default/FIX-42' },
      ]);
      await add(MACHINE, [{ kind: 'pull-request', key: 'github.com/FIXTURE/REPO#42' }]);
      await add(MACHINE, [{ kind: 'pull-request', key: 'github.com/fixture/repo#43' }]);
      const done = await add(MACHINE, [{ kind: 'pull-request', key: 'github.com/fixture/repo#44' }]);
      const detached = await add(MACHINE, [{ kind: 'pull-request', key: 'github.com/fixture/repo#45' }]);
      await add('different-machine', [{ kind: 'pull-request', key: 'github.com/fixture/repo#46' }]);
      await run(
        store.applyWorkThreadCommand({ dbPath, machineId: MACHINE, now: NOW, command: follow(done, 1, 'done') }),
      );
      db.query('UPDATE work_thread_links SET detached_at = ? WHERE thread_id = ?').run(LATER, detached);
      db.query("UPDATE work_thread_links SET link_key = ? WHERE thread_id = ? AND kind = 'pull-request'").run(
        'GitHub.COM/Fixture/Repo#42',
        first,
      );
      const limited = await run(
        store.queryActiveWorkThreadLinks({ dbPath, machineId: MACHINE, kind: 'pull-request', limit: 1 }),
      );
      expect(limited.links).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      const complete = await run(
        store.queryActiveWorkThreadLinks({ dbPath, machineId: MACHINE, kind: 'pull-request', limit: 100 }),
      );
      expect(complete.links.map((link) => link.key).toSorted()).toEqual([PR, 'github.com/fixture/repo#43']);
      expect(complete.truncated).toBe(false);
      expect(
        (
          await run(store.queryActiveWorkThreadLinks({ dbPath, machineId: MACHINE, kind: 'jira-issue', limit: 100 }))
        ).links.map((link) => link.key),
      ).toEqual(['jira:default/FIX-42']);
    } finally {
      db.close();
    }
  });

  test('observation eligibility precedes the active-link bound and keeps failures after a merge', async () => {
    const dbPath = await createStore();
    await create(dbPath, {
      links: [1, 2, 3].map((number) => ({ kind: 'pull-request', key: `github.com/fixture/repo#${number}` })),
    });
    const observed = (number: number, overrides: Record<string, unknown> = {}) => ({
      accountLabel: null,
      baseRef: 'main',
      checksRollup: 'success',
      draft: false,
      headRef: 'fixture',
      host: 'github.com',
      machineId: MACHINE,
      mergedAt: NOW,
      number,
      observedAt: NOW,
      outcome: 'observed',
      outcomeMessage: null,
      repository: 'Fixture/Repo',
      reviewDecision: null,
      state: 'MERGED',
      title: 'Merged fixture',
      updatedAt: NOW,
      url: `https://github.com/Fixture/Repo/pull/${number}`,
      ...overrides,
    });
    expect(
      await run(
        importPullRequestObservations({
          dbPath,
          observations: [
            observed(1),
            observed(1, {
              observedAt: LATER,
              outcome: 'timeout',
              outcomeMessage: 'Timed out',
              repository: 'fixture/repo',
            }),
            observed(2),
            observed(3, { machineId: 'other-machine' }),
          ],
        }),
      ),
    ).toMatchObject({ inserted: 4, rejected: 0 });
    const query = { dbPath, machineId: MACHINE, kind: 'pull-request' as const, limit: 100 };
    expect((await run(queryActiveWorkThreadLinks(query))).links).toHaveLength(3);
    const pending = await run(queryActiveWorkThreadLinks({ ...query, excludeObservedMerged: true }));
    expect(pending.links.map((link) => link.key).toSorted()).toEqual([
      'github.com/fixture/repo#1',
      'github.com/fixture/repo#3',
    ]);
    expect(pending.truncated).toBe(false);
    expect(await run(queryActiveWorkThreadLinks({ ...query, excludeObservedMerged: true, limit: 1 }))).toMatchObject({
      truncated: true,
    });
  });

  test('batches latest event history and active/detached links with independent thread limits', async () => {
    const { db, dbPath, store, createThread, counts } = await evidenceFixture();
    try {
      const first = await createThread([{ kind: 'session', key: SESSION }]);
      const second = await createThread([{ kind: 'session', key: SESSION }]);
      const insertEvent = db.query('INSERT INTO work_thread_events VALUES (?, ?, ?, ?)');
      const insertLink = db.query('INSERT INTO work_thread_links VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (const threadId of [first, second]) {
          for (let index = 0; index < WORK_THREAD_BOUNDS.maxEventsPerThread + 4; index++) {
            const eventId = randomUUID();
            insertEvent.run(
              eventId,
              threadId,
              LATER,
              JSON.stringify({
                eventId,
                threadId,
                at: LATER,
                kind: 'note',
                acknowledgedRemainders: [],
                fromState: null,
                toState: null,
                linkKey: null,
                reason: `Note ${index}`,
              }),
            );
            insertLink.run(randomUUID(), threadId, 'session', SESSION, 'user', NOW, LATER);
          }
        }
      })();
      const before = counts();
      const events = await run(store.queryWorkThreadEvents({ dbPath, threadIds: [first, second] }));
      expect(counts().connections - before.connections).toBe(1);
      expect(counts().queries - before.queries).toBe(5); // Four schema checks, one scoped event query.
      for (const threadId of [first, second]) {
        const scoped = events.filter((event) => event.threadId === threadId);
        expect(scoped).toHaveLength(WORK_THREAD_BOUNDS.maxEventsPerThread);
        expect(scoped[0]?.reason).toBe('Note 4');
      }
      const links = await run(store.queryWorkThreadLinks({ dbPath, threadIds: [first, second] }));
      for (const threadId of [first, second]) {
        const scoped = links.filter((link) => link.threadId === threadId);
        expect(scoped).toHaveLength(WORK_THREAD_BOUNDS.maxEventsPerThread + 1);
        expect(scoped.filter((link) => link.detachedAt === null)).toHaveLength(1);
      }
      expect(await run(store.queryWorkThreadEvents({ dbPath, threadIds: [] }))).toEqual([]);
      expect(await run(store.queryWorkThreadLinks({ dbPath, threadIds: [] }))).toEqual([]);
    } finally {
      db.close();
    }
  });

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

  test('seed deduplication includes operator and declared links on any thread and legacy PR casing', async () => {
    const dbPath = await createStore();
    const operator = await create(dbPath, {
      links: [
        { kind: 'pull-request', key: 'GitHub.COM/Fixture/Repo#42' },
        { kind: 'jira-issue', key: 'jira:default/FIX-42' },
      ],
    });
    await command(dbPath, follow(operator, 1, 'done'));
    const db = new Database(dbPath);
    db.query("UPDATE work_thread_links SET provenance = 'declared', link_key = ? WHERE kind = 'pull-request'").run(
      'GitHub.COM/Fixture/Repo#42',
    );
    db.close();
    const jira: WorkThreadSeed = {
      ...seed(),
      origin: 'jira-issue',
      linkKind: 'jira-issue',
      originKey: 'jira:default/FIX-42',
    };
    expect(
      await run(seedWorkThreads({ dbPath, machineId: 'different-machine', now: NOW, seeds: [seed(), jira] })),
    ).toEqual({ created: 0, existing: 2 });
    const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [operator] }));
    if (!link) {
      throw new Error('Expected link');
    }
    await command(dbPath, { op: 'detach-link', commandId: randomUUID(), threadId: operator, linkId: link.linkId });
    expect(
      await run(
        seedWorkThreads({
          dbPath,
          machineId: MACHINE,
          now: NOW,
          seeds: [link.kind === 'pull-request' ? seed() : jira],
        }),
      ),
    ).toEqual({ created: 0, existing: 1 });
    expect(
      await run(
        seedWorkThreads({
          dbPath,
          machineId: MACHINE,
          now: NOW,
          seeds: [link.kind === 'pull-request' ? { ...seed(), originKey: 'GitHub.COM/FIXTURE/REPO#42' } : jira],
        }),
      ),
    ).toEqual({ created: 0, existing: 1 });
  });

  test.each([seed(), seed({ origin: 'jira-issue', linkKind: 'jira-issue', originKey: 'jira:default/FIX-42' })])(
    'preserves detached $linkKind seed suppression while allowing an explicit relink',
    async (candidate) => {
      const dbPath = await createStore();
      const threadId = await create(dbPath, {
        links: [{ kind: candidate.linkKind, key: candidate.originKey }],
      });
      const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
      if (!link) {
        throw new Error('Expected operator link');
      }
      await command(dbPath, { op: 'detach-link', commandId: randomUUID(), threadId, linkId: link.linkId });
      const before = threadSnapshot(dbPath);
      const input = { dbPath, machineId: MACHINE, now: LATER, seeds: [candidate] };
      expect(await run(seedWorkThreads(input))).toEqual({ created: 0, existing: 1 });
      expect(threadSnapshot(dbPath)).toEqual(before);
      expect(
        await command(
          dbPath,
          { op: 'link', commandId: randomUUID(), threadId, kind: candidate.linkKind, key: candidate.originKey },
          LATER,
        ),
      ).toMatchObject({ applied: true, ok: true, threadId });
      const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
      expect(links).toHaveLength(2);
      expect(links.find((item) => item.linkId === link.linkId)?.detachedAt).toBe(NOW);
      expect(links.filter((item) => item.detachedAt === null)).toMatchObject([
        { kind: candidate.linkKind, key: candidate.originKey, provenance: 'user', createdAt: LATER },
      ]);
      expect(await run(seedWorkThreads(input))).toEqual({ created: 0, existing: 1 });
      expect(await run(countWorkThreads({ dbPath }))).toEqual({ done: 0, open: 1 });
      expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toMatchObject([
        { kind: 'created' },
        { kind: 'link-detached' },
        { kind: 'link-added' },
      ]);
    },
  );

  test('canonicalizes PR and branch authorities while preserving branch ref case and legacy deduplication', async () => {
    const dbPath = await createStore();
    const threadId = await create(dbPath, {
      links: [
        { kind: 'pull-request', key: 'GitHub.COM/Fixture/Repo#42' },
        { kind: 'pull-request', key: PR },
        { kind: 'branch', key: 'branch:GitHub.COM/Fixture/Repo@Feature' },
        { kind: 'branch', key: 'branch:github.com/fixture/repo@Feature' },
        { kind: 'branch', key: 'branch:github.com/fixture/repo@feature' },
      ],
    });
    const links = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
    expect(links.map((link) => link.key).toSorted()).toEqual(
      [PR, 'branch:github.com/fixture/repo@Feature', 'branch:github.com/fixture/repo@feature'].toSorted(),
    );
    const db = new Database(dbPath);
    db.query("UPDATE work_thread_links SET link_key = ? WHERE kind = 'pull-request'").run('GitHub.COM/Fixture/Repo#42');
    db.query(
      "UPDATE work_thread_links SET link_key = ? WHERE kind = 'branch' AND link_key = 'branch:github.com/fixture/repo@Feature'",
    ).run('branch:GitHub.COM/Fixture/Repo@Feature');
    db.close();
    for (const link of [
      { kind: 'pull-request' as const, key: PR },
      { kind: 'branch' as const, key: 'branch:github.com/fixture/repo@Feature' },
    ]) {
      expect(await command(dbPath, { op: 'link', commandId: randomUUID(), threadId, ...link })).toMatchObject({
        ok: true,
        applied: false,
      });
    }
  });

  test('malformed links still fail as invalid input before storage, and omitted create links remain accepted', async () => {
    const dbPath = await createStore();
    for (const links of ['bad', [null], [{ kind: 'pull-request', key: 42 }]]) {
      const malformed: WorkThreadCommand = JSON.parse(JSON.stringify({ ...createCommand(), links }));
      const result = await Effect.runPromise(
        Effect.result(applyWorkThreadCommand({ dbPath, machineId: MACHINE, now: NOW, command: malformed })),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure.reason).toBe('invalid-input');
      }
    }
    const omitted: WorkThreadCommand = JSON.parse(JSON.stringify({ ...createCommand(), links: undefined }));
    expect(await command(dbPath, omitted)).toMatchObject({ ok: true });
    expect(await run(countWorkThreads({ dbPath }))).toEqual({ done: 0, open: 1 });
  });

  test('seed validation rolls back the complete batch and canonicalizes discovered instants', async () => {
    const dbPath = await createStore();
    const failed = await Effect.runPromise(
      Effect.result(
        seedWorkThreads({
          dbPath,
          machineId: MACHINE,
          now: NOW,
          seeds: [seed(), seed({ originKey: 'not-a-qualified-key' })],
        }),
      ),
    );
    expect(failed._tag).toBe('Failure');
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
      Effect.result(
        queryWorkThreadsPage({
          dbPath,
          query: { cursor: first.nextCursor, limit: 1, project: 'other', search: null, tab: 'open' },
        }),
      ),
    );
    expect(invalid._tag).toBe('Failure');
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
    const result = await Effect.runPromise(Effect.result(queryWorkThreadById({ dbPath, threadId })));
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.reason).toBe('corrupt');
    }
  });

  test('readers do not create missing thread tables', async () => {
    const dbPath = await createStore();
    const db = new Database(dbPath);
    db.exec(
      'DROP TABLE work_thread_commands; DROP TABLE work_thread_events; DROP TABLE work_thread_links; DROP TABLE work_threads',
    );
    db.close();
    const result = await Effect.runPromise(Effect.result(countWorkThreads({ dbPath })));
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.reason).toBe('schema-too-old');
    }
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.query("SELECT name FROM sqlite_schema WHERE name = 'work_threads'").get()).toBeNull();
    reopened.close();
  });
});

const waitAt = (minute: number) => parseCanonicalInstant(new Date(Date.parse(NOW) + minute * 60_000).toISOString());
const waitPullRequest = (overrides: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
  accountLabel: null,
  baseRef: 'main',
  checksRollup: 'pending',
  draft: false,
  headRef: 'feature',
  host: 'GitHub.com',
  machineId: MACHINE,
  mergedAt: null,
  number: 42,
  observedAt: waitAt(20),
  outcome: 'observed',
  outcomeMessage: null,
  repository: 'Fixture/Repo',
  reviewDecision: 'REVIEW_REQUIRED',
  state: 'OPEN',
  title: 'Change',
  updatedAt: waitAt(15),
  url: 'https://github.com/Fixture/Repo/pull/42',
  ...overrides,
});
const waitJira = (overrides: Partial<JiraIssueObservation> = {}): JiraIssueObservation => ({
  assigneeLabel: null,
  commentCount: 0,
  comments: [],
  key: 'ABC-42',
  machineId: MACHINE,
  observedAt: waitAt(20),
  outcome: 'observed',
  outcomeMessage: null,
  parentKey: null,
  sprint: null,
  status: 'Open',
  statusCategory: 'todo',
  summary: 'Change',
  updatedAt: waitAt(15),
  ...overrides,
});
const createWaiting = async (
  dbPath: string,
  kind: 'pull-request-review' | 'jira-update' = 'pull-request-review',
  key = PR,
) => {
  const threadId = await create(dbPath, {
    links: [{ kind: kind === 'jira-update' ? 'jira-issue' : 'pull-request', key }],
  });
  await command(
    dbPath,
    follow(threadId, 1, 'waiting', {
      waitingFor: 'External response',
      waitingOn: { kind, linkKey: key, since: waitAt(10) },
    }),
    waitAt(10),
  );
  return threadId;
};
const captureWaits = (
  dbPath: string,
  kind: 'pull-request-review' | 'jira-update' = 'pull-request-review',
  linkKeys = [PR],
) => run(queryWorkThreadWaitCandidates({ dbPath, machineId: MACHINE, kind, linkKeys }));

describe('work thread waits', () => {
  test.each(['APPROVED', 'CHANGES_REQUESTED'])(
    'satisfies a proven %s review once and records its source time',
    async (reviewDecision) => {
      const dbPath = await createStore();
      const threadId = await createWaiting(dbPath, 'pull-request-review', 'github.com/Fixture/Repo#42');
      await run(importPullRequestObservations({ dbPath, observations: [waitPullRequest()] }));
      const { candidates } = await captureWaits(dbPath);
      expect(candidates).toHaveLength(1);
      const generations = await run(queryUsageStoreGenerations({ dbPath }));
      const observation = waitPullRequest({ reviewDecision, observedAt: LATER, updatedAt: waitAt(40) });
      // Unstored provider payloads are not durable evidence.
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: LATER,
            candidates,
            pullRequests: [observation],
          }),
        ),
      ).toMatchObject({ satisfied: 0 });
      await run(importPullRequestObservations({ dbPath, observations: [observation] }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: LATER,
            candidates,
            pullRequests: [observation],
          }),
        ),
      ).toEqual({ satisfied: 1, unchanged: 0, unproven: 0 });
      expect(await run(queryWorkThreadById({ dbPath, threadId }))).toMatchObject({
        followState: 'following',
        followRevision: 3,
        waitingOn: null,
        waitingFor: null,
      });
      const events = await run(queryWorkThreadEvents({ dbPath, threadId }));
      expect(events.filter(({ kind }) => kind === 'wait-satisfied')).toMatchObject([
        {
          fromState: 'waiting',
          toState: 'following',
          linkKey: PR,
          reason: `Pull request review ${reviewDecision}; source updated at ${waitAt(40)}; previous REVIEW_REQUIRED observed at ${waitAt(20)}`,
        },
      ]);
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: waitAt(90),
            candidates,
            pullRequests: [observation],
          }),
        ),
      ).toEqual({ satisfied: 0, unchanged: 1, unproven: 0 });
      expect((await captureWaits(dbPath)).candidates).toHaveLength(0);
      expect(await run(queryWorkThreadEvents({ dbPath, threadId }))).toEqual(events);
      expect(await run(queryUsageStoreGenerations({ dbPath }))).toEqual(generations);
    },
  );

  test('satisfies a merge by its explicit date without a review baseline', async () => {
    const dbPath = await createStore();
    const threadId = await createWaiting(dbPath);
    const { candidates } = await captureWaits(dbPath);
    const observation = waitPullRequest({ observedAt: LATER, updatedAt: LATER, mergedAt: waitAt(30), state: 'MERGED' });
    await run(importPullRequestObservations({ dbPath, observations: [observation] }));
    expect(
      await run(
        applyWorkThreadWaitObservations({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          candidates,
          pullRequests: [observation],
        }),
      ),
    ).toMatchObject({ satisfied: 1 });
    expect((await run(queryWorkThreadEvents({ dbPath, threadId }))).at(-1)?.reason).toBe(
      `Pull request MERGED at ${waitAt(30)}`,
    );
  });

  test.each(['following', 'done', 'waiting', 'relinked'] as const)(
    'does not overwrite an operator change to %s',
    async (move) => {
      const dbPath = await createStore();
      const threadId = await createWaiting(dbPath);
      await run(importPullRequestObservations({ dbPath, observations: [waitPullRequest()] }));
      const { candidates } = await captureWaits(dbPath);
      if (move === 'relinked') {
        const [link] = await run(queryWorkThreadLinks({ dbPath, threadIds: [threadId] }));
        await command(
          dbPath,
          { commandId: randomUUID(), op: 'detach-link', threadId, linkId: link!.linkId },
          waitAt(25),
        );
        await command(
          dbPath,
          { commandId: randomUUID(), op: 'link', threadId, key: PR, kind: 'pull-request' },
          waitAt(26),
        );
      } else {
        await command(dbPath, follow(threadId, 2, move === 'waiting' ? 'following' : move), waitAt(25));
        if (move === 'waiting') {
          await command(
            dbPath,
            follow(threadId, 3, 'waiting', {
              waitingFor: 'New wait',
              waitingOn: { kind: 'pull-request-review', linkKey: PR, since: waitAt(10) },
            }),
            waitAt(26),
          );
        }
      }
      const before = threadSnapshot(dbPath);
      const observation = waitPullRequest({ reviewDecision: 'APPROVED', observedAt: LATER, updatedAt: waitAt(40) });
      await run(importPullRequestObservations({ dbPath, observations: [observation] }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: LATER,
            candidates,
            pullRequests: [observation],
          }),
        ),
      ).toMatchObject({ satisfied: 0 });
      expect(threadSnapshot(dbPath)).toEqual(before);
      if (move === 'done') {
        expect((await captureWaits(dbPath)).candidates).toHaveLength(0);
      }
    },
  );

  test.each(['older', 'equal', 'comment', 'ci', 'agent-review', 'future', 'old-baseline', 'no-baseline'] as const)(
    'leaves %s review evidence waiting',
    async (scenario) => {
      const dbPath = await createStore();
      const threadId = await createWaiting(dbPath);
      if (scenario !== 'no-baseline') {
        await run(
          importPullRequestObservations({
            dbPath,
            observations: [
              waitPullRequest({
                reviewDecision: scenario === 'comment' ? 'APPROVED' : 'REVIEW_REQUIRED',
                observedAt: scenario === 'old-baseline' ? waitAt(5) : waitAt(20),
                updatedAt: scenario === 'old-baseline' ? waitAt(4) : waitAt(15),
              }),
            ],
          }),
        );
      }
      const { candidates } = await captureWaits(dbPath);
      let updatedAt = waitAt(40);
      if (scenario === 'older') {
        updatedAt = waitAt(9);
      }
      if (scenario === 'equal') {
        updatedAt = waitAt(10);
      }
      const observation = waitPullRequest({
        observedAt: scenario === 'future' ? waitAt(90) : LATER,
        updatedAt,
        reviewDecision: scenario === 'ci' || scenario === 'agent-review' ? 'REVIEW_REQUIRED' : 'APPROVED',
        checksRollup: 'success',
      });
      await run(importPullRequestObservations({ dbPath, observations: [observation] }));
      const result = await run(
        applyWorkThreadWaitObservations({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          candidates,
          pullRequests: [observation],
        }),
      );
      expect(result.satisfied).toBe(0);
      expect(result.unproven).toBe(
        scenario === 'old-baseline' || scenario === 'no-baseline' || scenario === 'comment' ? 1 : 0,
      );
      expect((await run(queryWorkThreadById({ dbPath, threadId })))?.followState).toBe('waiting');
      expect(
        (await run(queryWorkThreadEvents({ dbPath, threadId }))).some(({ kind }) => kind === 'wait-satisfied'),
      ).toBe(false);
    },
  );

  test('uses Jira status transitions proved after the wait, never just a newer update or another site', async () => {
    const dbPath = await createStore();
    const threadId = await createWaiting(dbPath, 'jira-update', 'jira:default/ABC-42');
    const anotherSite = await createWaiting(dbPath, 'jira-update', 'jira:other/ABC-42');
    await run(importJiraIssueObservations({ dbPath, observations: [waitJira()] }));
    let captured = await captureWaits(dbPath, 'jira-update', ['jira:default/ABC-42', 'jira:other/ABC-42']);
    const comment = waitJira({ observedAt: waitAt(30), updatedAt: waitAt(25), commentCount: 1 });
    await run(importJiraIssueObservations({ dbPath, observations: [comment] }));
    expect(
      await run(
        applyWorkThreadWaitObservations({
          dbPath,
          machineId: MACHINE,
          now: waitAt(30),
          candidates: captured.candidates,
          jiraIssues: [comment],
        }),
      ),
    ).toMatchObject({ satisfied: 0 });
    captured = await captureWaits(dbPath, 'jira-update', ['jira:default/ABC-42', 'jira:other/ABC-42']);
    const changed = waitJira({
      observedAt: LATER,
      updatedAt: waitAt(40),
      status: 'In Progress',
      statusCategory: 'in-progress',
    });
    await run(importJiraIssueObservations({ dbPath, observations: [changed] }));
    expect(
      await run(
        applyWorkThreadWaitObservations({
          dbPath,
          machineId: MACHINE,
          now: LATER,
          candidates: captured.candidates,
          jiraIssues: [changed],
        }),
      ),
    ).toMatchObject({ satisfied: 1 });
    expect((await run(queryWorkThreadById({ dbPath, threadId })))?.followState).toBe('following');
    expect((await run(queryWorkThreadById({ dbPath, threadId: anotherSite })))?.followState).toBe('waiting');
    expect((await run(queryWorkThreadEvents({ dbPath, threadId }))).at(-1)?.reason).toBe(
      `Jira status Open -> In Progress; source updated at ${waitAt(40)}; previous observed at ${waitAt(30)}`,
    );
  });

  test.each([true, false])(
    'leaves Jira without a usable baseline waiting (older baseline: %s)',
    async (oldBaseline) => {
      const dbPath = await createStore();
      const threadId = await createWaiting(dbPath, 'jira-update', 'jira:default/ABC-42');
      if (oldBaseline) {
        await run(
          importJiraIssueObservations({
            dbPath,
            observations: [waitJira({ observedAt: waitAt(5), updatedAt: waitAt(4) })],
          }),
        );
      }
      const { candidates } = await captureWaits(dbPath, 'jira-update', ['jira:default/ABC-42']);
      const observation = waitJira({
        observedAt: LATER,
        updatedAt: waitAt(40),
        status: 'Done',
        statusCategory: 'done',
      });
      await run(importJiraIssueObservations({ dbPath, observations: [observation] }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: LATER,
            candidates,
            jiraIssues: [observation],
          }),
        ),
      ).toEqual({ satisfied: 0, unchanged: 1, unproven: 1 });
      expect((await run(queryWorkThreadById({ dbPath, threadId })))?.followState).toBe('waiting');
    },
  );
});

describe('work thread wait recovery', () => {
  test.each(['review', 'merge', 'jira'] as const)(
    'accepts a %s change during a provider read, before apply time',
    async (kind) => {
      const dbPath = await createStore();
      const jira = kind === 'jira';
      const threadId = await createWaiting(
        dbPath,
        jira ? 'jira-update' : 'pull-request-review',
        jira ? 'jira:default/ABC-42' : PR,
      );
      if (jira) {
        await run(importJiraIssueObservations({ dbPath, observations: [waitJira()] }));
      } else {
        await run(importPullRequestObservations({ dbPath, observations: [waitPullRequest()] }));
      }
      const { candidates } = await captureWaits(dbPath, jira ? 'jira-update' : 'pull-request-review', [
        jira ? 'jira:default/ABC-42' : PR,
      ]);
      const pullRequests = jira
        ? []
        : [
            waitPullRequest({
              observedAt: waitAt(30),
              updatedAt: waitAt(31),
              reviewDecision: 'APPROVED',
              state: kind === 'merge' ? 'MERGED' : 'OPEN',
              mergedAt: kind === 'merge' ? waitAt(31) : null,
            }),
          ];
      const jiraIssues = jira
        ? [waitJira({ observedAt: waitAt(30), updatedAt: waitAt(31), status: 'Done', statusCategory: 'done' })]
        : [];
      await run(importPullRequestObservations({ dbPath, observations: pullRequests }));
      await run(importJiraIssueObservations({ dbPath, observations: jiraIssues }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: waitAt(32),
            candidates,
            pullRequests,
            jiraIssues,
          }),
        ),
      ).toMatchObject({ satisfied: 1 });
      expect((await run(queryWorkThreadById({ dbPath, threadId })))?.followState).toBe('following');
      expect((await run(queryWorkThreadEvents({ dbPath, threadId }))).at(-1)?.reason).toContain(waitAt(31));
    },
  );

  test.each(['review', 'jira'] as const)(
    'recovers a stored %s transition after interrupted apply without duplicating its event',
    async (kind) => {
      const dbPath = await createStore();
      const jira = kind === 'jira';
      const threadId = await createWaiting(
        dbPath,
        jira ? 'jira-update' : 'pull-request-review',
        jira ? 'jira:default/ABC-42' : PR,
      );
      const approved = waitPullRequest({ observedAt: waitAt(30), updatedAt: waitAt(25), reviewDecision: 'APPROVED' });
      const changed = waitJira({
        observedAt: waitAt(30),
        updatedAt: waitAt(25),
        status: 'Done',
        statusCategory: 'done',
      });
      if (jira) {
        await run(importJiraIssueObservations({ dbPath, observations: [waitJira(), changed] }));
      } else {
        await run(importPullRequestObservations({ dbPath, observations: [waitPullRequest(), approved] }));
      }
      // A new capture after a restart still includes the successful baseline and transition.
      const { candidates } = await captureWaits(dbPath, jira ? 'jira-update' : 'pull-request-review', [
        jira ? 'jira:default/ABC-42' : PR,
      ]);
      const pullRequests = jira ? [] : [{ ...approved, observedAt: waitAt(40) }];
      const jiraIssues = jira ? [{ ...changed, observedAt: waitAt(40) }] : [];
      await run(importPullRequestObservations({ dbPath, observations: pullRequests }));
      await run(importJiraIssueObservations({ dbPath, observations: jiraIssues }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: waitAt(40),
            candidates,
            pullRequests,
            jiraIssues,
          }),
        ),
      ).toMatchObject({ satisfied: 1 });
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: waitAt(41),
            candidates,
            pullRequests,
            jiraIssues,
          }),
        ),
      ).toMatchObject({ satisfied: 0 });
      expect(
        (await run(queryWorkThreadEvents({ dbPath, threadId }))).filter(
          ({ kind: eventKind }) => eventKind === 'wait-satisfied',
        ),
      ).toHaveLength(1);
    },
  );

  test('missing native review decision never establishes a baseline, and its diagnostic survives a repeated poll', async () => {
    const dbPath = await createStore();
    const threadId = await createWaiting(dbPath);
    await run(importPullRequestObservations({ dbPath, observations: [waitPullRequest({ reviewDecision: null })] }));
    for (const minute of [30, 40]) {
      const { candidates } = await captureWaits(dbPath);
      const observation = waitPullRequest({
        reviewDecision: 'APPROVED',
        observedAt: waitAt(minute),
        updatedAt: waitAt(25),
      });
      await run(importPullRequestObservations({ dbPath, observations: [observation] }));
      expect(
        await run(
          applyWorkThreadWaitObservations({
            dbPath,
            machineId: MACHINE,
            now: waitAt(minute),
            candidates,
            pullRequests: [observation],
          }),
        ),
      ).toEqual({ satisfied: 0, unchanged: 1, unproven: 1 });
    }
    expect((await run(queryWorkThreadById({ dbPath, threadId })))?.followState).toBe('waiting');
  });

  test('a merged PR remains eligible until all bounded waiting candidates have been satisfied', async () => {
    const dbPath = await createStore();
    const template = await createWaiting(dbPath);
    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        for (let index = 0; index < 500; index++) {
          const id = randomUUID();
          db.query(
            'INSERT INTO work_threads SELECT ?,machine_id,title,objective,project_label,intent,origin,origin_key,follow_state,follow_revision,waiting_for,waiting_on_json,done_at,done_reason,note,created_at,updated_at,last_activity_at FROM work_threads WHERE thread_id = ?',
          ).run(id, template);
          db.query(`INSERT INTO work_thread_links VALUES (?,?,'pull-request',?,'user',?,NULL)`).run(
            randomUUID(),
            id,
            PR,
            NOW,
          );
        }
      })();
    } finally {
      db.close();
    }
    const merged = waitPullRequest({
      observedAt: waitAt(30),
      updatedAt: waitAt(25),
      mergedAt: waitAt(25),
      state: 'MERGED',
    });
    await run(importPullRequestObservations({ dbPath, observations: [merged] }));
    const eligible = () =>
      run(
        queryActiveWorkThreadLinks({
          dbPath,
          machineId: MACHINE,
          kind: 'pull-request',
          excludeObservedMerged: true,
          limit: 40,
        }),
      );
    expect((await eligible()).links).toHaveLength(1);
    const first = await captureWaits(dbPath);
    expect(first.truncated).toBe(true);
    expect(first.candidates).toHaveLength(500);
    expect(
      await run(
        applyWorkThreadWaitObservations({ dbPath, machineId: MACHINE, now: waitAt(40), candidates: first.candidates }),
      ),
    ).toMatchObject({ satisfied: 500 });
    expect((await eligible()).links).toHaveLength(1);
    const second = await captureWaits(dbPath);
    expect(second.truncated).toBe(false);
    expect(second.candidates).toHaveLength(1);
    expect(
      await run(
        applyWorkThreadWaitObservations({ dbPath, machineId: MACHINE, now: waitAt(41), candidates: second.candidates }),
      ),
    ).toMatchObject({ satisfied: 1 });
    expect((await eligible()).links).toHaveLength(0);
    const final = new Database(dbPath, { readonly: true });
    try {
      expect(
        final
          .query(
            `SELECT COUNT(*) AS count FROM work_thread_events WHERE json_extract(event_json, '$.kind') = 'wait-satisfied'`,
          )
          .get(),
      ).toEqual({ count: 501 });
    } finally {
      final.close();
    }
    const oldMergeWait = await createWaiting(dbPath);
    await command(dbPath, follow(oldMergeWait, 2, 'following'), waitAt(40));
    await command(
      dbPath,
      follow(oldMergeWait, 3, 'waiting', {
        waitingOn: { kind: 'pull-request-review', linkKey: PR, since: waitAt(40) },
      }),
      waitAt(40),
    );
    expect((await eligible()).links).toHaveLength(0);
  });
});
