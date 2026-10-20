import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCodexSessionAnalysis } from '@ai-usage/local-machine/codex-session-analysis';
import { setCodexSkillObservationCeilingForTesting } from '@ai-usage/local-machine/codex-skill-observation';
import { LocalHistoryError } from '@ai-usage/local-machine/errors';
import { createCodexSessionParser, resolveCodexRolloutFiles } from '@ai-usage/local-machine/internal/codex-history';
import {
  createLocalHistoryStorage,
  type LocalHistoryDirEntry,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { TestMemoryStorage } from '@ai-usage/local-machine/testing/memory-storage';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import {
  compareSessionProjectionFacts,
  parseSessionDetail,
  type SessionDetail,
  sessionProjectionFactsForSerializedRow,
} from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import {
  findLatestCodexProviderStatus,
  findLatestCodexQuotaSnapshot,
  readCodexUsageSessions,
  readCodexUsageSessionsResult,
} from './codex-history';
import { sessionToUsageRow } from './collected-session';
import { collectCodex, collectCodexResult } from './collectors/codex';

const SIMULATED_LARGE_SESSION_BYTES = 600 * 1024 * 1024;

const readCodexDetailForTest = (sourceSessionId: string) =>
  readCodexSessionAnalysis(sourceSessionId).pipe(Effect.map((analysis) => analysis?.detail ?? null));

class LargeAggregateCodexStorage extends TestMemoryStorage {
  override readDir(dirPath: string) {
    return super
      .readDir(dirPath)
      .pipe(
        Effect.map((entries) =>
          entries.map(
            (entry): LocalHistoryDirEntry =>
              entry.isRegularFile && entry.name.endsWith('.jsonl')
                ? { ...entry, size: SIMULATED_LARGE_SESSION_BYTES }
                : entry,
          ),
        ),
      );
  }
}

class SimulatedBudgetCodexStorage extends TestMemoryStorage {
  private readonly simulatedBytes = new Map<string, number>();

  setSimulatedBytes(relativePath: string, bytes: number): void {
    this.simulatedBytes.set(path.join(this.home, relativePath), bytes);
  }

  override readLines(
    filePath: string,
    visit: (line: string) => void,
    limits: { maxBytes?: number; maxLineBytes?: number } = {},
  ) {
    const simulatedBytes = this.simulatedBytes.get(filePath);
    if (simulatedBytes !== undefined && simulatedBytes > (limits.maxBytes ?? Number.POSITIVE_INFINITY)) {
      return Effect.fail(
        new LocalHistoryError({
          cause: new Error('Fixture exceeds the remaining aggregate budget'),
          operation: 'readLines',
          path: filePath,
        }),
      );
    }
    return super
      .readLines(filePath, visit, limits)
      .pipe(Effect.map((result) => ({ ...result, bytes: simulatedBytes ?? result.bytes })));
  }
}

/**
 * Codex reads with the default per-line bound. Narrowing it here keeps the
 * fixture readable instead of writing a 32 MiB pasted image to disk.
 */
class NarrowLineBudgetCodexStorage extends TestMemoryStorage {
  override readLines(
    filePath: string,
    visit: (line: string) => void,
    limits: { maxBytes?: number; maxLineBytes?: number } = {},
  ) {
    return super.readLines(filePath, visit, { ...limits, maxLineBytes: 512 });
  }
}

class CountingCodexDatabaseStorage extends TestMemoryStorage {
  databaseOpens = 0;

  override openDatabase(dbPath: string) {
    this.databaseOpens++;
    return super.openDatabase(dbPath);
  }
}

const jsonl = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
// `runPromise`, not `runSync`: the Codex scan sleeps 0 ms after each slice of
// read-and-parse work, which `runSync` cannot run, so a slow runner would fail
// a synchronous test with an AsyncFiberException.
const runWithStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, storage: TestMemoryStorage) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
const runWithRealStorage = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, home: string) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));

const requireSessionDetail = (detail: SessionDetail | null): SessionDetail => {
  if (!detail) {
    throw new Error('Expected a Codex session detail');
  }
  return detail;
};

test('preserves VCS from the first identity-owning Codex session_meta only', async () => {
  const storage = new TestMemoryStorage();
  storage.writeText(
    '.codex/sessions/2026/codex-vcs.jsonl',
    jsonl(
      {
        timestamp: '2026-07-01T08:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-vcs',
          cwd: '/work/project',
          git: {
            branch: 'recorded/main',
            commit_hash: '0123456789abcdef0123456789abcdef01234567',
            repository_url: 'git@github.com:fixture/project.git',
          },
        },
      },
      {
        timestamp: '2026-07-01T08:00:01.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-vcs',
          git: {
            branch: 'later/wrong',
            commit_hash: 'ffffffffffffffffffffffffffffffffffffffff',
            repository_url: 'https://github.com/wrong/project',
          },
        },
      },
      {
        timestamp: '2026-07-01T08:00:02.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              total_tokens: 3,
              input_tokens: 2,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
      },
    ),
  );

  const [session] = await runWithStorage(readCodexUsageSessions, storage);
  expect(session?.source.vcs).toMatchObject({
    branches: [{ name: 'recorded/main', provenance: 'harness-recorded' }],
    headCommit: { hash: '0123456789abcdef0123456789abcdef01234567', provenance: 'harness-recorded' },
    repository: { host: 'github.com', ownerPath: 'fixture/project', provenance: 'harness-recorded' },
  });
  expect(JSON.stringify(session?.source.vcs)).not.toContain('later/wrong');
  expect(JSON.stringify(session?.source.vcs)).not.toContain('wrong/project');
});

describe('Codex local history', () => {
  test('closes the metadata database when a query fails', async () => {
    const home = '/home/codex-close-fixture';
    const stateDbPath = path.join(home, '.codex', 'state_5.sqlite');
    let closed = false;
    const storage: LocalHistoryStorageService = {
      home,
      exists: (filePath) => Effect.succeed(filePath === stateDbPath),
      openDatabase: () =>
        Effect.succeed({
          all: () =>
            Effect.fail(
              new LocalHistoryError({
                operation: 'sqlite.all',
                path: stateDbPath,
                cause: new Error('Fixture query failure'),
              }),
            ),
          close: Effect.sync(() => {
            closed = true;
          }),
        }),
      readDir: () => Effect.succeed([]),
      readLines: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readLines',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
      readText: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readText',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
      readConfigText: (filePath) =>
        Effect.fail(
          new LocalHistoryError({
            operation: 'readConfigText',
            path: filePath,
            cause: new Error('Unexpected fixture read'),
          }),
        ),
    };

    const sessions = await Effect.runPromise(
      readCodexUsageSessions.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(sessions).toEqual([]);
    expect(closed).toBe(true);
  });

  test('parses sessions, child sessions, names, and quota snapshots through fixture storage', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/session_index.jsonl', jsonl({ id: 'parent-thread', thread_name: 'Fixture thread' }));
    storage.writeText(
      '.codex/sessions/2026/parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'parent-thread', cwd: '/work/fixture-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'parent-turn' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex', turn_id: 'parent-turn' },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                input_text: `Tu travailles dans le repository suivant : /work/fixture-project.
Lis les instructions du dépôt avant toute modification.

# Mission
Build the report.
Preserve the existing aggregation semantics.`,
              },
            ],
          },
        },
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 30,
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 18,
              },
            },
            rate_limits: {
              plan_type: 'pro',
              primary: { used_percent: 50, window_minutes: 300 },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/child.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:05:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'child-thread',
            cwd: '/work/fixture-project',
            source: {
              subagent: { thread_spawn: { parent_thread_id: 'parent-thread', agent_nickname: 'builder-agent' } },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:06:00.000Z',
          payload: { type: 'task_started', turn_id: 'child-turn' },
        },
        {
          timestamp: '2026-01-01T00:07:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex', turn_id: 'child-turn' },
        },
        {
          timestamp: '2026-01-01T00:08:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 5,
                cached_input_tokens: 1,
                output_tokens: 4,
              },
              last_token_usage: {
                total_tokens: 9,
                input_tokens: 5,
                cached_input_tokens: 1,
                output_tokens: 4,
              },
            },
          },
        },
      ),
    );

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.name).toBe('Build the report.');
    expect(sessions[0]?.origin).toBeUndefined();
    expect(sessions[0]?.provider).toBe('Codex sub');
    expect(sessions[0]?.project).toBe('fixture-project');
    expect(sessions[0]?.projectPath).toBe('/work/fixture-project');
    expect(sessions[0]?.source).toEqual({
      harnessKey: 'codex',
      sourceSessionId: 'parent-thread',
      sourcePath: '/work/fixture-project',
    });
    expect(sessions[0]?.titleSource).toBe('first-prompt');
    expect(sessions[0]?.tokens.in).toBe(10);
    expect(sessions[0]?.tokens.cr).toBe(2);
    expect(sessions[0]?.tokens.out).toBe(18);
    expect(sessions[0]?.calls).toBe(1);
    expect(sessions[0]?.turns).toBe(1);
    expect(sessions[0]?.subagent).toBe(true);
    expect(sessions[0]?.usageUnavailable).toBe(false);
    expect(sessions[1]?.name).toBe('builder-agent');
    expect(sessions[1]?.origin).toBe('subagent');
    expect(sessions[1]?.titleSource).toBe('agent-role');
    expect(sessions[1]?.provider).toBe('Codex sub');
    expect(sessions[1]?.projectPath).toBe('/work/fixture-project');
    expect(sessions[1]?.source.parentSourceSessionId).toBe('parent-thread');
    expect(sessions[1]?.tokens.in).toBe(4);
    expect(sessions[1]?.tokens.cr).toBe(1);
    expect(sessions[1]?.tokens.out).toBe(4);
    expect(sessions[1]?.calls).toBe(1);
    expect(sessions[1]?.turns).toBe(1);
    expect(sessions[1]?.subagent).toBe(true);
    expect(sessions[1]?.usageUnavailable).toBe(false);

    const quota = await runWithStorage(findLatestCodexQuotaSnapshot(), storage);
    expect(quota?.planType).toBe('pro');
    expect(quota?.primary?.usedPercent).toBe(50);
    expect(quota?.primary?.windowMinutes).toBe(300);

    const status = await runWithStorage(
      findLatestCodexProviderStatus({ machineId: 'machine-1', machineLabel: 'Test Machine' }),
      storage,
    );
    expect(status).toMatchObject({
      key: 'codex',
      label: 'Codex',
      machineId: 'machine-1',
      machineLabel: 'Test Machine',
      plan: 'pro',
      source: 'local-history',
      state: 'ok',
    });
    expect(status?.windows[0]).toMatchObject({ id: 'primary', label: '5h', usedPercent: 50, limitSeconds: 18_000 });

    const rows = await runWithStorage(collectCodex, storage);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe('Build the report.');
    expect(rows[0]?.origin).toBeUndefined();
    expect(rows[0]?.provider).toBe('Codex sub');
    expect(rows[0]?.project).toBe('fixture-project');
    expect(rows[0]?.projectPath).toBe('/work/fixture-project');
    expect(rows[0]?.source).toEqual({
      harnessKey: 'codex',
      sourceSessionId: 'parent-thread',
      sourcePath: '/work/fixture-project',
    });
    expect(rows[0]?.titleSource).toBe('first-prompt');
    expect(rows[0]?.tokIn).toBe(10);
    expect(rows[0]?.tokCr).toBe(2);
    expect(rows[0]?.tokOut).toBe(18);
    expect(rows[0]?.calls).toBe(1);
    expect(rows[0]?.turns).toBe(1);
    expect(rows[0]?.subagent).toBe(true);
    expect(rows[0]?.usageUnavailable).toBe(false);
    expect(rows[1]?.name).toBe('builder-agent');
    expect(rows[1]?.origin).toBe('subagent');
    expect(rows[1]?.titleSource).toBe('agent-role');
    expect(rows[1]?.provider).toBe('Codex sub');
    expect(rows[1]?.source?.parentSourceSessionId).toBe('parent-thread');
    expect(rows[1]?.tokIn).toBe(4);
    expect(rows[1]?.tokCr).toBe(1);
    expect(rows[1]?.tokOut).toBe(4);
    expect(rows[1]?.subagent).toBe(true);
    expect(rows[1]?.usageUnavailable).toBe(false);
  });

  test('classifies every declared Codex origin shape and resolves classifier parents', async () => {
    const storage = new TestMemoryStorage();
    const classifierParentId = '11111111-2222-4333-8444-555555555555';
    const guardianPrompt = `The following is the Codex agent history.\nReviewed Codex session id: ${classifierParentId}`;
    const writeFixture = (id: string, metadata: Record<string, unknown>, ...events: unknown[]): void => {
      storage.writeText(
        `.codex/sessions/2026/${id}.jsonl`,
        jsonl(
          {
            timestamp: '2026-02-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id, cwd: '/work/origin-fixture', ...metadata },
          },
          ...events,
        ),
      );
    };

    writeFixture(classifierParentId, { thread_source: 'user' });
    writeFixture('thread-spawn-unset', {
      source: { subagent: { thread_spawn: { parent_thread_id: classifierParentId } } },
      thread_source: 'subagent',
    });
    writeFixture('thread-spawn-explorer', {
      source: {
        subagent: { thread_spawn: { agent_role: 'explorer', parent_thread_id: classifierParentId } },
      },
      thread_source: 'subagent',
    });
    writeFixture('thread-spawn-worker', {
      source: {
        subagent: { thread_spawn: { agent_role: 'worker', parent_thread_id: classifierParentId } },
      },
      thread_source: 'subagent',
    });
    writeFixture('thread-spawn-precedence', {
      source: {
        subagent: {
          other: 'guardian',
          thread_spawn: { agent_role: 'review', parent_thread_id: classifierParentId },
        },
      },
      thread_source: 'subagent',
    });
    writeFixture(
      'guardian-classifier',
      { source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' },
      {
        timestamp: '2026-02-01T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ input_text: guardianPrompt }],
        },
      },
    );
    writeFixture('review-classifier', {
      parent_thread_id: classifierParentId,
      source: { subagent: 'review' },
      thread_source: 'subagent',
    });
    writeFixture(
      'undeclared-origin',
      {},
      {
        timestamp: '2026-02-01T00:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ input_text: guardianPrompt }],
        },
      },
    );

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    const sessionsById = new Map(sessions.map((session) => [session.source.sourceSessionId, session]));

    expect(sessionsById.get(classifierParentId)?.origin).toBe('human');
    expect(sessionsById.get(classifierParentId)?.originProvenance).toBeUndefined();
    expect(sessionsById.get('undeclared-origin')?.origin).toBeUndefined();
    expect(sessionsById.get('undeclared-origin')?.originProvenance).toBe('origin-absent');
    expect(sessionsById.get('undeclared-origin')?.source.rootSourceSessionId).toBeUndefined();
    for (const sessionId of [
      'thread-spawn-unset',
      'thread-spawn-explorer',
      'thread-spawn-worker',
      'thread-spawn-precedence',
    ]) {
      expect(sessionsById.get(sessionId)?.origin).toBe('subagent');
    }
    for (const sessionId of ['guardian-classifier', 'review-classifier']) {
      const classifier = sessionsById.get(sessionId);
      expect(classifier?.origin).toBe('classifier');
      expect(classifier?.source.rootSourceSessionId).toBe(classifierParentId);
      expect(classifier?.name).not.toContain('Codex guardian approval');
      expect(sessionsById.has(classifier?.source.rootSourceSessionId ?? null)).toBe(true);
    }

    const collectedById = new Map(
      (await runWithStorage(collectCodex, storage)).map((row) => [row.source?.sourceSessionId, row]),
    );
    expect(collectedById.get('guardian-classifier')?.origin).toBe('classifier');
    expect(collectedById.get('guardian-classifier')?.source?.rootSourceSessionId).toBe(classifierParentId);
    expect(collectedById.get('review-classifier')?.origin).toBe('classifier');
    expect(collectedById.get('review-classifier')?.source?.rootSourceSessionId).toBe(classifierParentId);
  });

  test('preserves full classifier parent identities when their eight-character prefixes collide', async () => {
    const storage = new TestMemoryStorage();
    const parentIds = ['019f9e7d-1111-4111-8111-111111111111', '019f9e7d-2222-4222-8222-222222222222'] as const;
    const classifierIds = ['guardian-first', 'guardian-second'] as const;

    for (const parentId of parentIds) {
      storage.writeText(
        `.codex/sessions/2026/${parentId}.jsonl`,
        jsonl({
          timestamp: '2026-02-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { cwd: '/work/colliding-parents', id: parentId, thread_source: 'user' },
        }),
      );
    }
    for (const [index, classifierId] of classifierIds.entries()) {
      const parentId = parentIds[index]!;
      storage.writeText(
        `.codex/sessions/2026/${classifierId}.jsonl`,
        jsonl(
          {
            timestamp: '2026-02-01T00:00:00.000Z',
            type: 'session_meta',
            payload: {
              cwd: '/work/colliding-parents',
              id: classifierId,
              source: { subagent: { other: 'guardian' } },
              thread_source: 'subagent',
            },
          },
          {
            timestamp: '2026-02-01T00:00:01.000Z',
            payload: {
              content: [
                {
                  input_text: `The following is the Codex agent history.\nReviewed Codex session id: ${parentId}`,
                },
              ],
              role: 'user',
              type: 'message',
            },
          },
        ),
      );
    }

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    const sessionsById = new Map(sessions.map((session) => [session.source.sourceSessionId, session]));
    expect(parentIds.map((parentId) => sessionsById.get(parentId)?.name)).toEqual(
      parentIds.map((parentId) => `codex ${parentId}`),
    );
    expect(classifierIds.map((classifierId) => sessionsById.get(classifierId)?.source.rootSourceSessionId)).toEqual([
      ...parentIds,
    ]);
    expect(
      new Set(classifierIds.map((classifierId) => sessionsById.get(classifierId)?.source.rootSourceSessionId)).size,
    ).toBe(2);
    for (const classifierId of classifierIds) {
      expect(sessionsById.get(classifierId)?.name).not.toContain('019f9e7d');
    }
  });

  test('attributes a shared cumulative token stream only to the campaign root', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/shared-parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/shared-child-a.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'shared-child-a',
            cwd: '/work/shared-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'shared-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project', source: 'vscode' },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/shared-child-b.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'shared-child-b',
            cwd: '/work/shared-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'shared-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          type: 'session_meta',
          payload: { id: 'shared-parent', cwd: '/work/shared-project', source: 'vscode' },
        },
        {
          timestamp: '2026-01-01T00:05:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:09:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 90,
                input_tokens: 72,
                cached_input_tokens: 54,
                output_tokens: 18,
              },
            },
          },
        },
      ),
    );

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    const parent = sessions.find((session) => session.source.sourceSessionId === 'shared-parent');
    const children = sessions.filter((session) => session.source.parentSourceSessionId === 'shared-parent');

    expect(parent?.tokens).toEqual({ cr: 60, cw: 0, in: 20, out: 20 });
    expect(parent?.usageUnavailable).toBe(false);
    expect(children).toHaveLength(2);
    expect(children.map((session) => session.tokens)).toEqual([
      { cr: 0, cw: 0, in: 0, out: 0 },
      { cr: 0, cw: 0, in: 0, out: 0 },
    ]);
    expect(children.every((session) => session.modelSegments === undefined)).toBe(true);
    expect(children.every((session) => session.usageUnavailable)).toBe(true);

    for (const child of children) {
      const analysis = await runWithStorage(readCodexSessionAnalysis(child.source.sourceSessionId ?? ''), storage);
      const reportRow = sessionToUsageRow(child);
      const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
      const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput));

      expect(analysis).not.toBeNull();
      expect(analysis?.projection).toEqual(reportProjection);
      expect(analysis ? compareSessionProjectionFacts(reportProjection, analysis.projection) : null).toMatchObject({
        status: 'cannot-compare',
      });
    }
  });

  test('keeps cached rollout parsing independent from changing state metadata', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-state-detail-'));
    try {
      const sessionsDirectory = path.join(home, '.codex', 'sessions', '2026');
      mkdirSync(sessionsDirectory, { recursive: true });
      writeFileSync(
        path.join(sessionsDirectory, 'rollout-state-root.jsonl'),
        jsonl(
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: 'state-root', cwd: '/work/state-project' },
          },
          {
            timestamp: '2026-01-01T00:02:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 100,
                  input_tokens: 80,
                  cached_input_tokens: 60,
                  output_tokens: 20,
                },
              },
            },
          },
        ),
      );
      writeFileSync(
        path.join(sessionsDirectory, 'rollout-state-child.jsonl'),
        jsonl(
          {
            timestamp: '2026-01-01T00:01:00.000Z',
            type: 'session_meta',
            payload: { id: 'state-child', cwd: '/work/state-project' },
          },
          {
            timestamp: '2026-01-01T00:03:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  total_tokens: 10,
                  input_tokens: 8,
                  cached_input_tokens: 6,
                  output_tokens: 2,
                },
                total_token_usage: {
                  total_tokens: 50,
                  input_tokens: 40,
                  cached_input_tokens: 30,
                  output_tokens: 10,
                },
              },
            },
          },
          {
            timestamp: '2026-01-01T00:04:00.000Z',
            payload: { type: 'task_started', turn_id: 'state-child-turn' },
          },
          {
            timestamp: '2026-01-01T00:04:01.000Z',
            type: 'turn_context',
            payload: { model: 'codex', turn_id: 'state-child-turn' },
          },
          {
            timestamp: '2026-01-01T00:05:00.000Z',
            payload: { duration_ms: 60_000, type: 'task_complete', turn_id: 'state-child-turn' },
          },
        ),
      );

      const stateDirectory = path.join(home, '.codex');
      mkdirSync(stateDirectory, { recursive: true });
      const stateDatabase = new Database(path.join(stateDirectory, 'state_5.sqlite'));
      try {
        stateDatabase.exec(`
          CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            title TEXT,
            first_user_message TEXT,
            source TEXT,
            thread_source TEXT,
            model TEXT,
            created_at INTEGER,
            updated_at INTEGER
          );
          CREATE TABLE thread_spawn_edges (
            parent_thread_id TEXT,
            child_thread_id TEXT
          );
        `);
        const insertThread = stateDatabase.query(`
          INSERT INTO threads (
            id, cwd, title, first_user_message, source, thread_source, model, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertThread.run(
          'state-root',
          '/work/state-project',
          'State root',
          'Run the campaign',
          'vscode',
          null,
          'gpt-5.9-state',
          1_767_225_600,
          1_767_225_720,
        );
        insertThread.run(
          'state-child',
          '/work/state-project',
          'State child',
          'Handle the child task',
          JSON.stringify({ subagent: { thread_spawn: { agent_nickname: 'state-agent' } } }),
          'subagent',
          'gpt-5.9-state',
          1_767_225_660,
          1_767_225_780,
        );
        const insertSpawnEdge = stateDatabase.query(
          'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)',
        );
        insertSpawnEdge.run('state-root', 'state-child');
        insertSpawnEdge.run('state-root', 'state-child');
      } finally {
        stateDatabase.close();
      }

      const storage = createLocalHistoryStorage(home);
      const firstSessions = await runWithRealStorage(readCodexUsageSessions, home);
      const firstRoot = firstSessions.find((session) => session.source.sourceSessionId === 'state-root');
      const firstChild = firstSessions.find((session) => session.source.sourceSessionId === 'state-child');
      expect(firstRoot?.name).toBe('Run the campaign');
      expect(firstRoot?.origin).toBeUndefined();
      expect(firstRoot?.titleSource).toBe('first-prompt');
      expect(firstChild?.model).toBe('gpt-5.9-state');
      expect(firstChild?.origin).toBe('subagent');

      const updatedStateDatabase = new Database(path.join(stateDirectory, 'state_5.sqlite'));
      try {
        updatedStateDatabase
          .query('UPDATE threads SET model = ?, title = ? WHERE id = ?')
          .run('gpt-5.10-state', 'Updated state child', 'state-child');
      } finally {
        updatedStateDatabase.close();
      }

      const sessions = await runWithRealStorage(readCodexUsageSessions, home);
      const child = sessions.find((session) => session.source.sourceSessionId === 'state-child');
      const analysis = await Effect.runPromise(
        readCodexSessionAnalysis('state-child').pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(child).toBeDefined();
      expect(analysis).not.toBeNull();
      if (!(child?.date && child.endDate && analysis)) {
        throw new Error('Expected the state-backed Codex child and its local analysis');
      }
      const reportRow = sessionToUsageRow(child);
      const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
      const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput));

      expect(child.model).toBe('gpt-5.10-state');
      expect(child.source.parentSourceSessionId).toBe('state-root');
      expect(analysis.detail.models).toEqual(['gpt-5.10-state']);
      expect(analysis.detail.turns.map((turn) => turn.model)).toEqual(['gpt-5.10-state']);
      expect(analysis.detail.startedAt).toBe(child.date.toISOString());
      expect(analysis.detail.endedAt).toBe(child.endDate.toISOString());
      expect(analysis.projection).toEqual(reportProjection);
      expect(compareSessionProjectionFacts(reportProjection, analysis.projection)).toMatchObject({
        status: 'cannot-compare',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('treats duplicate and conflicting state parent edges identically in report and detail', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-parent-edges-'));
    try {
      const sessionsDirectory = path.join(home, '.codex', 'sessions', '2026');
      mkdirSync(sessionsDirectory, { recursive: true });
      const tokenEvent = (timestamp: string, totalTokens: number, withPriorUsage: boolean) => ({
        timestamp,
        payload: {
          type: 'token_count',
          info: {
            ...(withPriorUsage
              ? {
                  last_token_usage: {
                    total_tokens: 10,
                    input_tokens: 8,
                    cached_input_tokens: 6,
                    output_tokens: 2,
                  },
                }
              : {}),
            total_token_usage: {
              total_tokens: totalTokens,
              input_tokens: totalTokens - 10,
              cached_input_tokens: totalTokens - 20,
              output_tokens: 10,
            },
          },
        },
      });
      writeFileSync(
        path.join(sessionsDirectory, 'edge-root.jsonl'),
        jsonl(
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: 'edge-root', cwd: '/work/edge-project' },
          },
          tokenEvent('2026-01-01T00:01:00.000Z', 100, false),
        ),
      );
      writeFileSync(
        path.join(sessionsDirectory, 'edge-child.jsonl'),
        jsonl(
          {
            timestamp: '2026-01-01T00:00:30.000Z',
            type: 'session_meta',
            payload: { id: 'edge-child', cwd: '/work/edge-project' },
          },
          tokenEvent('2026-01-01T00:01:30.000Z', 50, true),
        ),
      );

      const stateDatabase = new Database(path.join(home, '.codex', 'state_5.sqlite'), { create: true });
      try {
        stateDatabase.exec(`
          CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            title TEXT,
            first_user_message TEXT,
            source TEXT,
            thread_source TEXT,
            model TEXT,
            created_at INTEGER,
            updated_at INTEGER
          );
          CREATE TABLE thread_spawn_edges (
            parent_thread_id TEXT,
            child_thread_id TEXT
          );
          INSERT INTO threads (id, cwd, model) VALUES
            ('edge-root', '/work/edge-project', 'gpt-5.9-state'),
            ('edge-child', '/work/edge-project', 'gpt-5.9-state');
          INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES
            ('edge-root', 'edge-child'),
            ('edge-root', 'edge-child'),
            ('edge-conflict', 'edge-child');
        `);
      } finally {
        stateDatabase.close();
      }

      const sessions = await runWithRealStorage(readCodexUsageSessions, home);
      const child = sessions.find((session) => session.source.sourceSessionId === 'edge-child');
      const analysis = await runWithRealStorage(readCodexSessionAnalysis('edge-child'), home);

      expect(child).toBeDefined();
      expect(analysis).not.toBeNull();
      if (!(child && analysis)) {
        throw new Error('Expected the conflicting-edge report row and local analysis');
      }
      const reportRow = sessionToUsageRow(child);
      const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
      const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput));

      expect(child.source.parentSourceSessionId).toBeUndefined();
      expect(analysis.projection).toEqual(reportProjection);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uses the same bounded lineage semantics for report rows and local analysis', async () => {
    const storage = new TestMemoryStorage();
    const lineageDepth = 33;
    for (let index = 0; index <= lineageDepth; index += 1) {
      const sessionId = `bounded-lineage-${index}`;
      const parentSessionId = index === 0 ? null : `bounded-lineage-${index - 1}`;
      const totalTokens = index === 0 ? 100 : 50;
      storage.writeText(
        `.codex/sessions/2026/${sessionId}.jsonl`,
        jsonl(
          {
            timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
            type: 'session_meta',
            payload: {
              id: sessionId,
              cwd: '/work/bounded-lineage',
              ...(parentSessionId === null
                ? {}
                : { source: { subagent: { thread_spawn: { parent_thread_id: parentSessionId } } } }),
            },
          },
          {
            timestamp: `2026-01-01T00:01:${String(index).padStart(2, '0')}.000Z`,
            payload: {
              type: 'token_count',
              info: {
                ...(index === 0
                  ? {}
                  : {
                      last_token_usage: {
                        total_tokens: 10,
                        input_tokens: 8,
                        cached_input_tokens: 6,
                        output_tokens: 2,
                      },
                    }),
                total_token_usage: {
                  total_tokens: totalTokens,
                  input_tokens: totalTokens - 10,
                  cached_input_tokens: totalTokens - 20,
                  output_tokens: 10,
                },
              },
            },
          },
        ),
      );
    }

    const sourceSessionId = `bounded-lineage-${lineageDepth}`;
    const session = (await runWithStorage(readCodexUsageSessions, storage)).find(
      (candidate) => candidate.source.sourceSessionId === sourceSessionId,
    );
    const analysis = await runWithStorage(readCodexSessionAnalysis(sourceSessionId), storage);

    expect(session).toBeDefined();
    expect(analysis).not.toBeNull();
    if (!(session && analysis)) {
      throw new Error('Expected the bounded-lineage report row and local analysis');
    }
    const reportRow = sessionToUsageRow(session);
    const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
    const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput));

    expect(analysis.projection).toEqual(reportProjection);
    expect(compareSessionProjectionFacts(reportProjection, analysis.projection)).toMatchObject({
      status: 'matches-report',
    });
  });

  test('makes lineage-budget truncation incomparable instead of reporting false drift', async () => {
    const storage = new SimulatedBudgetCodexStorage();
    const rootPath = '.codex/sessions/2026/budget-root.jsonl';
    const childPath = '.codex/sessions/2026/budget-child.jsonl';
    storage.writeText(
      rootPath,
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'budget-root', cwd: '/work/budget-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      childPath,
      jsonl(
        {
          timestamp: '2026-01-01T00:00:30.000Z',
          type: 'session_meta',
          payload: {
            id: 'budget-child',
            cwd: '/work/budget-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'budget-root' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:01:30.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 10,
                input_tokens: 8,
                cached_input_tokens: 6,
                output_tokens: 2,
              },
              total_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
            },
          },
        },
      ),
    );
    storage.setSimulatedBytes(childPath, 100 * 1024 * 1024);
    storage.setSimulatedBytes(rootPath, 64 * 1024 * 1024);

    const session = (await runWithStorage(readCodexUsageSessions, storage)).find(
      (candidate) => candidate.source.sourceSessionId === 'budget-child',
    );
    const analysis = await runWithStorage(readCodexSessionAnalysis('budget-child'), storage);

    expect(session).toBeDefined();
    expect(analysis).not.toBeNull();
    if (!(session && analysis)) {
      throw new Error('Expected the budgeted report row and bounded local analysis');
    }
    const reportRow = sessionToUsageRow(session);
    const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
    const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput));

    expect(analysis.projection).toEqual({
      ...reportProjection,
      modelSegments: null,
    });
    expect(compareSessionProjectionFacts(reportProjection, analysis.projection)).toMatchObject({
      status: 'cannot-compare',
    });
  });

  test('reads state metadata for a detail lineage through one database lease', async () => {
    const storage = new CountingCodexDatabaseStorage();
    const sessionIds = ['single-lease-root', 'single-lease-parent', 'single-lease-child'];
    for (const [index, sessionId] of sessionIds.entries()) {
      const parentSessionId = index === 0 ? null : sessionIds[index - 1]!;
      storage.writeText(
        `.codex/sessions/2026/${sessionId}.jsonl`,
        jsonl({
          timestamp: `2026-01-01T00:00:0${index}.000Z`,
          type: 'session_meta',
          payload: {
            id: sessionId,
            cwd: '/work/single-lease',
            ...(parentSessionId === null
              ? {}
              : { source: { subagent: { thread_spawn: { parent_thread_id: parentSessionId } } } }),
          },
        }),
      );
      storage.writeDatabaseRows(
        '.codex/state_5.sqlite',
        { includes: ['from threads', 'where id = ?'] },
        [
          {
            createdAt: null,
            cwd: '/work/single-lease',
            firstUser: null,
            id: sessionId,
            model: null,
            source: null,
            threadSource: index === 0 ? null : 'subagent',
            title: null,
            updatedAt: null,
          },
        ],
        [sessionId],
      );
      storage.writeDatabaseRows(
        '.codex/state_5.sqlite',
        { includes: ['from thread_spawn_edges', 'where child_thread_id = ?'] },
        parentSessionId === null ? [] : [{ child: sessionId, parent: parentSessionId }],
        [sessionId],
      );
    }

    const analysis = await runWithStorage(readCodexSessionAnalysis('single-lease-child'), storage);

    expect(analysis).not.toBeNull();
    expect(storage.databaseOpens).toBe(1);
  });

  test('collects sessions whose aggregate metadata exceeds the former 2 GiB ceiling', async () => {
    const storage = new LargeAggregateCodexStorage();
    const sessionIds = ['large-one', 'large-two', 'large-three', 'large-four'];
    for (const [index, sessionId] of sessionIds.entries()) {
      storage.writeText(
        `.codex/sessions/2026/${sessionId}.jsonl`,
        jsonl(
          {
            timestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
            type: 'session_meta',
            payload: { id: sessionId, cwd: `/work/${sessionId}` },
          },
          {
            timestamp: `2026-01-0${index + 1}T00:01:00.000Z`,
            type: 'event_msg',
            payload: { type: 'task_started' },
          },
          {
            timestamp: `2026-01-0${index + 1}T00:02:00.000Z`,
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 15,
                  input_tokens: 10,
                  cached_input_tokens: 2,
                  output_tokens: 5,
                },
              },
            },
          },
        ),
      );
    }

    const rows = await runWithStorage(collectCodex, storage);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.source?.sourceSessionId).sort()).toEqual(sessionIds.sort());
    expect(rows.every((row) => row.tokIn === 8 && row.tokCr === 2 && row.tokOut === 5)).toBe(true);
  });

  test('keeps the last valid Codex snapshot and reports malformed metrics once', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/metrics.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'metrics-thread', cwd: '/work/metrics' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 20,
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 8,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 30,
                input_tokens: 'private-invalid-value',
                cached_input_tokens: 3,
                output_tokens: 10,
              },
            },
          },
        },
      ),
    );

    const result = await runWithStorage(collectCodexResult, storage);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tokIn).toBe(10);
    expect(result.rows[0]?.tokCr).toBe(2);
    expect(result.rows[0]?.tokOut).toBe(8);
    expect(result.warnings).toEqual([
      {
        affectedSessions: 1,
        lastObservedAt: '2026-01-01T00:02:00.000Z',
        harness: 'codex',
        operation: 'metricValidation',
        message: 'Rejected 1 malformed codex metric record(s).',
        rejectedRecords: 1,
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('private-invalid-value');
  });

  test('accepts rate-limit-only Codex snapshots without a malformed metric warning', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/quota-only.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'quota-only-thread', cwd: '/work/quota-only' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: null,
            rate_limits: {
              plan_type: 'pro',
              primary: { used_percent: 50, window_minutes: 300 },
            },
          },
        },
      ),
    );

    const result = await runWithStorage(collectCodexResult, storage);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.provider).toBe('Codex sub');
    expect(result.rows[0]?.usageUnavailable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('prefers exact rollout names and continues through suffix collisions', async () => {
    const rollout = (sourceSessionId: string) =>
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { cwd: '/work/suffix-collision', id: sourceSessionId },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: `${sourceSessionId}-turn` },
        },
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-codex', turn_id: `${sourceSessionId}-turn` },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { type: 'task_complete', turn_id: `${sourceSessionId}-turn` },
        },
      );
    const exactStorage = new TestMemoryStorage();
    exactStorage.writeText('.codex/sessions/2026/z-target.jsonl', rollout('z-target'));
    exactStorage.writeText('.codex/sessions/2026/target.jsonl', rollout('target'));

    const exactAnalysis = await runWithStorage(readCodexSessionAnalysis('target'), exactStorage);

    expect(exactAnalysis?.detail.sourceSessionId).toBe('target');

    const fallbackStorage = new TestMemoryStorage();
    fallbackStorage.writeText('.codex/sessions/2026/z-target.jsonl', rollout('z-target'));
    fallbackStorage.writeText('.codex/sessions/2026/a-target.jsonl', rollout('target'));

    const fallbackAnalysis = await runWithStorage(readCodexSessionAnalysis('target'), fallbackStorage);

    expect(fallbackAnalysis?.detail.sourceSessionId).toBe('target');
  });

  test('reconstructs active turns, model phases, costs, and bounded deduplicated prompts', async () => {
    const storage = new TestMemoryStorage();
    const oversizedPrompt = `Second prompt ${'x'.repeat(40 * 1024)}`;
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-00-00-trace-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'trace-thread', cwd: '/work/trace-project' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { type: 'task_started', turn_id: 'replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_complete', turn_id: 'replayed-turn', duration_ms: 10_000 },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'sol-turn', started_at: 1_767_225_660 },
        },
        {
          timestamp: '2026-01-01T00:01:00.005Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'replayed-model', turn_id: 'unknown-replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:01:00.010Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'sol-turn' },
        },
        {
          timestamp: '2026-01-01T00:01:00.020Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Injected host instructions' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:01:00.030Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Build it' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:01:00.040Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Build it' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: '{}',
            internal_chat_message_metadata_passthrough: { turn_id: 'sol-turn' },
          },
        },
        {
          timestamp: '2026-01-01T01:01:05.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'unknown-replayed-turn',
            completed_at: 1_767_229_265,
            duration_ms: 9_999_999,
          },
        },
        {
          timestamp: '2026-01-01T01:01:05.100Z',
          payload: {
            type: 'task_complete',
            turn_id: 'sol-turn',
            completed_at: 1_767_229_265,
            duration_ms: 3_600_000,
          },
        },
        {
          timestamp: '2026-01-01T04:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'terra-turn', started_at: 1_767_240_060 },
        },
        {
          timestamp: '2026-01-01T04:01:00.010Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'gpt-5.6-terra', turn_id: 'terra-turn' },
        },
        {
          timestamp: '2026-01-01T04:01:00.020Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Another injected message' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'terra-turn' },
          },
        },
        {
          timestamp: '2026-01-01T04:01:00.030Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: oversizedPrompt }],
            internal_chat_message_metadata_passthrough: { turn_id: 'terra-turn' },
          },
        },
        {
          timestamp: '2026-01-01T04:01:30.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 110,
                input_tokens: 88,
                cached_input_tokens: 66,
                output_tokens: 22,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T04:02:07.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'terra-turn',
            completed_at: 1_767_240_127,
            duration_ms: 60_000,
          },
        },
      ),
    );

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    const detail = await runWithStorage(readCodexDetailForTest('trace-thread'), storage);
    const analysis = await runWithStorage(readCodexSessionAnalysis('trace-thread'), storage);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.model).toBe('gpt-5.6-sol');
    expect(sessions[0]?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(
      sessions[0]?.modelSegments?.map(({ costKnown, model, tokCr, tokCw, tokIn, tokOut }) => ({
        costKnown,
        model,
        tokCr,
        tokCw,
        tokIn,
        tokOut,
      })),
    ).toEqual([
      {
        costKnown: true,
        model: 'gpt-5.6-sol',
        tokCr: 60,
        tokCw: 0,
        tokIn: 20,
        tokOut: 20,
      },
      {
        costKnown: true,
        model: 'gpt-5.6-terra',
        tokCr: 6,
        tokCw: 0,
        tokIn: 2,
        tokOut: 2,
      },
    ]);
    expect(sessions[0]?.modelSegments?.[0]?.costApprox).toBeCloseTo(0.000_73, 10);
    expect(sessions[0]?.modelSegments?.[1]?.costApprox).toBeCloseTo(0.000_036_5, 10);
    expect(sessions[0]?.durationMs).toBe(3_660_000);
    expect(sessions[0]?.turns).toBe(2);
    expect(sessions[0]?.tools).toBe(1);
    expect(sessions[0]?.costApprox).toBeCloseTo(0.000_766_5, 10);
    expect(sessions[0]?.costKnown).toBe(true);
    expect(detail?.activeDurationMs).toBe(3_660_000);
    expect(detail?.elapsedDurationMs).toBe(14_467_000);
    expect(detail?.idleDurationMs).toBe(10_807_000);
    expect(detail?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(detail?.efforts).toEqual(['ultra', 'high']);
    expect(detail?.phases.map((phase) => phase.tokens.total)).toEqual([100, 10]);
    expect(detail?.turns.map((turn) => turn.durationMs)).toEqual([3_600_000, 60_000]);
    expect(detail?.prompts).toHaveLength(2);
    expect(detail?.prompts[0]?.text).toBe('Build it');
    expect(detail?.prompts[1]?.text.startsWith('Second prompt')).toBe(true);
    expect(detail?.prompts[1]?.truncated).toBe(true);
    expect(Buffer.byteLength(detail?.prompts[1]?.text ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024);
    const reportRow = sessionToUsageRow(sessions[0]!);
    const { projectPath: _projectPath, source: _source, ...serializedInput } = reportRow;
    expect(analysis?.projection).toEqual(sessionProjectionFactsForSerializedRow(serializeUsageRow(serializedInput)));
    expect(await runWithStorage(readCodexDetailForTest('../../private'), storage)).toBeNull();
  });

  test('marks a token-bearing segment with unknown model pricing as a lower bound', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/unknown-model-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unknown-model-thread', cwd: '/work/unknown-model' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: 'unknown-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.010Z',
          type: 'turn_context',
          payload: { model: 'private-codex-model', turn_id: 'unknown-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 13,
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 2000, type: 'task_complete', turn_id: 'unknown-model-turn' },
        },
      ),
    );

    const [session] = await runWithStorage(readCodexUsageSessions, storage);

    expect(session?.costApprox).toBe(0);
    expect(session?.costKnown).toBe(false);
    expect(session?.modelSegments).toEqual([
      {
        costApprox: 0,
        costKnown: false,
        model: 'private-codex-model',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 3,
      },
    ]);
  });

  test('attributes cumulative tokens to the only model observed in zero-token phases', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/single-model-cumulative-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'single-model-cumulative-thread', cwd: '/work/single-model-cumulative' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 15,
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 5,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: { type: 'task_started', turn_id: 'single-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'single-model-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'single-model-turn' },
        },
      ),
    );

    const [session] = await runWithStorage(readCodexUsageSessions, storage);
    const [row] = await runWithStorage(collectCodex, storage);

    expect(session?.modelSegments).toMatchObject([
      {
        costKnown: true,
        model: 'gpt-5.6-sol',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 5,
      },
    ]);
    expect(session?.modelSegments?.[0]?.costApprox).toBeCloseTo(0.000_191, 10);
    expect(session?.costApprox).toBeCloseTo(0.000_191, 10);
    expect(row).toMatchObject({
      costKnown: true,
      tokCr: 2,
      tokCw: 0,
      tokIn: 8,
      tokOut: 5,
      usageUnavailable: false,
    });
    expect(row?.costApprox).toBeCloseTo(0.000_191, 10);
  });

  test('keeps cumulative tokens unsegmented when zero-token phases observe multiple models', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/unattributed-cumulative-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unattributed-cumulative-thread', cwd: '/work/unattributed-cumulative' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 15,
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 5,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:02.000Z',
          payload: { type: 'task_started', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:02.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:03.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'later-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:04.000Z',
          payload: { type: 'task_started', turn_id: 'second-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:04.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', turn_id: 'second-context-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: { duration_ms: 1000, type: 'task_complete', turn_id: 'second-context-turn' },
        },
      ),
    );

    const [session] = await runWithStorage(readCodexUsageSessions, storage);
    const [row] = await runWithStorage(collectCodex, storage);

    expect(session?.tokens).toEqual({ cr: 2, cw: 0, in: 8, out: 5 });
    expect(session?.modelSegments).toEqual([
      {
        costApprox: 0,
        costKnown: false,
        model: '(multi-model, unsegmented)',
        tokCr: 2,
        tokCw: 0,
        tokIn: 8,
        tokOut: 5,
      },
    ]);
    expect(row).toMatchObject({
      costKnown: false,
      tokCr: 2,
      tokCw: 0,
      tokIn: 8,
      tokOut: 5,
      usageUnavailable: false,
    });
  });

  test('emits contract-valid active duration when completed turns overlap', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/overlap-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'overlap-thread', cwd: '/work/overlap-project' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: { type: 'task_started', turn_id: 'second-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:05.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'second-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'first-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:15.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'second-turn' },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = await runWithStorage(readCodexDetailForTest('overlap-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.durationMs).toBe(15_000);
    expect(validDetail.activeDurationMs).toBe(15_000);
    expect(validDetail.turns.map((turn) => turn.durationMs)).toEqual([10_000, 10_000]);
  });

  test('reconciles a recorded task duration with its turn interval while retaining the observed session end', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/recorded-duration-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'recorded-duration-thread', cwd: '/work/recorded-duration' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'recorded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'recorded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 2000, type: 'task_complete', turn_id: 'recorded-duration-turn' },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = requireSessionDetail(
      await runWithStorage(readCodexDetailForTest('recorded-duration-thread'), storage),
    );

    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(session?.durationMs).toBe(2000);
    expect(detail).toMatchObject({
      activeDurationMs: 2000,
      elapsedDurationMs: 10_000,
      endedAt: '2026-01-01T00:00:10.000Z',
      idleDurationMs: 8000,
      startedAt: '2026-01-01T00:00:00.000Z',
      turns: [
        {
          durationMs: 2000,
          endAt: '2026-01-01T00:00:02.000Z',
          intervals: [{ endAt: '2026-01-01T00:00:02.000Z', startAt: '2026-01-01T00:00:00.000Z' }],
          startAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  test('bounds a recorded task duration to the observed completion', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/bounded-duration-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'bounded-duration-thread', cwd: '/work/bounded-duration' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'bounded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'bounded-duration-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 20_000, type: 'task_complete', turn_id: 'bounded-duration-turn' },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = requireSessionDetail(
      await runWithStorage(readCodexDetailForTest('bounded-duration-thread'), storage),
    );

    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(session?.durationMs).toBe(10_000);
    expect(detail).toMatchObject({
      activeDurationMs: 10_000,
      elapsedDurationMs: 10_000,
      idleDurationMs: 0,
      turns: [{ durationMs: 10_000, endAt: '2026-01-01T00:00:10.000Z' }],
    });
  });

  test('treats an aborted turn as a recorded terminal event', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/aborted-turn-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'aborted-turn-thread', cwd: '/work/aborted-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: 'aborted-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'aborted-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.020Z',
          type: 'event_msg',
          payload: { message: 'Stop this turn', type: 'user_message' },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          type: 'event_msg',
          payload: {
            completed_at: 1_767_225_609,
            duration_ms: 7500,
            type: 'turn_aborted',
            turn_id: 'aborted-turn',
          },
        },
      ),
    );

    const analysis = await runWithStorage(readCodexSessionAnalysis('aborted-turn-thread'), storage);
    const detail = requireSessionDetail(analysis?.detail ?? null);
    const session = (await runWithStorage(readCodexUsageSessions, storage)).find(
      ({ source }) => source.sourceSessionId === 'aborted-turn-thread',
    );

    expect(parseSessionDetail(detail)).toEqual(detail);
    expect(analysis?.projection.partial).toBe(false);
    expect(session).toMatchObject({ durationMs: 7500, partial: false });
    expect(detail).toMatchObject({
      activeDurationMs: 7500,
      durationStatus: 'recorded',
      prompts: [{ id: 'prompt-1', text: 'Stop this turn' }],
      turns: [{ durationMs: 7500, promptIds: ['prompt-1'] }],
      turnsStatus: 'recorded',
    });
  });

  test('keeps contextual open turns visible and marks their coverage as partial', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/open-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'open-thread', cwd: '/work/open-project' },
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { type: 'task_started', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:00.002Z',
          type: 'event_msg',
          payload: { message: 'Complete this turn', type: 'user_message' },
        },
        {
          timestamp: '2026-01-01T00:00:05.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 2,
                input_tokens: 8,
                output_tokens: 2,
                total_tokens: 10,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:10.000Z',
          payload: { duration_ms: 10_000, type: 'task_complete', turn_id: 'completed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_started', turn_id: 'open-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.001Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'open-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:20.002Z',
          type: 'event_msg',
          payload: { message: 'Keep this turn open', type: 'user_message' },
        },
        {
          timestamp: '2026-01-01T00:00:25.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 5,
                input_tokens: 20,
                output_tokens: 5,
                total_tokens: 25,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:30.000Z',
          type: 'response_item',
          payload: {
            internal_chat_message_metadata_passthrough: { turn_id: 'open-turn' },
            name: 'shell',
            type: 'function_call',
          },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = await runWithStorage(readCodexDetailForTest('open-thread'), storage);
    const row = (await runWithStorage(collectCodex, storage))[0];

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(true);
    expect(row?.partial).toBe(true);
    expect(session?.durationMs).toBe(20_000);
    expect(session?.turns).toBe(2);
    expect(validDetail.durationStatus).toBe('partial');
    expect(validDetail.turnsStatus).toBe('recorded');
    expect(validDetail.activeDurationMs).toBe(20_000);
    expect(validDetail.turns.map(({ promptIds }) => promptIds)).toEqual([['prompt-1'], ['prompt-2']]);
    expect(validDetail.turns.map((turn) => [turn.durationMs, turn.tokens.total, turn.tools])).toEqual([
      [10_000, 10, 0],
      [10_000, 15, 1],
    ]);
  });

  test('keeps a delayed task that starts inside the observed rollout', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/delayed-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'delayed-thread', cwd: '/work/delayed-project' },
        },
        {
          timestamp: '2026-01-01T00:00:12.500Z',
          payload: { started_at: 1_767_225_610, type: 'task_started', turn_id: 'delayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:12.510Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'delayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:15.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 5,
                input_tokens: 15,
                output_tokens: 5,
                total_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:20.000Z',
          payload: { type: 'task_complete', turn_id: 'delayed-turn' },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = await runWithStorage(readCodexDetailForTest('delayed-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(false);
    expect(session?.turns).toBe(1);
    expect(session?.tokens).toEqual({ cr: 5, cw: 0, in: 10, out: 5 });
    expect(validDetail.turns.map((turn) => turn.tokens.total)).toEqual([20]);
  });

  test('marks an unparented pre-rollout replay candidate as partial without double counting it', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/ambiguous-replay-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          type: 'session_meta',
          payload: { id: 'ambiguous-replay-thread', cwd: '/work/ambiguous-replay' },
        },
        {
          timestamp: '2026-01-01T00:10:00.010Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                cached_input_tokens: 30,
                input_tokens: 40,
                output_tokens: 10,
                total_tokens: 50,
              },
              total_token_usage: {
                cached_input_tokens: 60,
                input_tokens: 80,
                output_tokens: 20,
                total_tokens: 100,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.020Z',
          payload: { started_at: 1_767_226_198, type: 'task_started', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.030Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.040Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 120,
                input_tokens: 160,
                output_tokens: 40,
                total_tokens: 200,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.050Z',
          payload: { type: 'task_complete', turn_id: 'ambiguous-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:10.100Z',
          payload: { started_at: 1_767_226_210, type: 'task_started', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:10.110Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:20.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 150,
                input_tokens: 200,
                output_tokens: 50,
                total_tokens: 250,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:11:10.000Z',
          payload: { duration_ms: 60_000, type: 'task_complete', turn_id: 'local-turn' },
        },
      ),
    );

    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const detail = await runWithStorage(readCodexDetailForTest('ambiguous-replay-thread'), storage);

    const validDetail = requireSessionDetail(detail);
    expect(parseSessionDetail(validDetail)).toEqual(validDetail);
    expect(session?.partial).toBe(true);
    expect(session?.turns).toBe(1);
    expect(session?.tokens).toEqual({ cr: 30, cw: 0, in: 10, out: 10 });
    expect(validDetail.durationStatus).toBe('recorded');
    expect(validDetail.turnsStatus).toBe('recorded');
    expect(validDetail.turns.map((turn) => [turn.model, turn.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
  });

  test('uses replayed token snapshots as a baseline without attributing replayed tasks', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-00-00-replay-parent.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'replay-parent', cwd: '/work/replay-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 1000,
                input_tokens: 800,
                cached_input_tokens: 600,
                output_tokens: 200,
              },
            },
          },
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-10-00-replay-child.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:10:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'replay-child',
            cwd: '/work/replay-project',
            source: { subagent: { thread_spawn: { parent_thread_id: 'replay-parent' } } },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.010Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
              total_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.020Z',
          payload: { type: 'task_started', turn_id: 'replayed-turn', started_at: 1_767_225_600 },
        },
        {
          timestamp: '2026-01-01T00:10:00.030Z',
          type: 'turn_context',
          payload: { effort: 'high', model: 'gpt-5.6-terra', turn_id: 'replayed-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:00.040Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 100,
                input_tokens: 80,
                cached_input_tokens: 60,
                output_tokens: 20,
              },
              total_token_usage: {
                total_tokens: 200,
                input_tokens: 160,
                cached_input_tokens: 120,
                output_tokens: 40,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.050Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            internal_chat_message_metadata_passthrough: { turn_id: 'replayed-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:10:00.060Z',
          payload: {
            type: 'task_complete',
            turn_id: 'replayed-turn',
            completed_at: 1_767_225_660,
            duration_ms: 60_000,
          },
        },
        {
          timestamp: '2026-01-01T00:10:10.100Z',
          payload: { type: 'task_started', turn_id: 'local-turn', started_at: 1_767_226_210 },
        },
        {
          timestamp: '2026-01-01T00:10:10.110Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'local-turn' },
        },
        {
          timestamp: '2026-01-01T00:10:20.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                total_tokens: 50,
                input_tokens: 40,
                cached_input_tokens: 30,
                output_tokens: 10,
              },
              total_token_usage: {
                total_tokens: 250,
                input_tokens: 200,
                cached_input_tokens: 150,
                output_tokens: 50,
              },
            },
          },
        },
        {
          timestamp: '2026-01-01T00:10:30.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            internal_chat_message_metadata_passthrough: { turn_id: 'local-turn' },
          },
        },
        {
          timestamp: '2026-01-01T00:11:10.000Z',
          payload: {
            type: 'task_complete',
            turn_id: 'local-turn',
            completed_at: 1_767_226_270,
            duration_ms: 60_000,
          },
        },
      ),
    );

    const sessions = await runWithStorage(readCodexUsageSessions, storage);
    const detail = await runWithStorage(readCodexDetailForTest('replay-child'), storage);
    const child = sessions.find((session) => session.source.sourceSessionId === 'replay-child');

    expect(sessions).toHaveLength(2);
    expect(child?.tokens).toEqual({ cr: 30, cw: 0, in: 10, out: 10 });
    expect(child?.models).toEqual(['gpt-5.6-sol']);
    expect(child?.turns).toBe(1);
    expect(child?.tools).toBe(1);
    expect(child?.durationMs).toBe(60_000);
    expect(child?.costKnown).toBe(true);
    expect(detail?.phases.map((phase) => [phase.model, phase.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
    expect(detail?.turns.map((turn) => [turn.model, turn.tokens.total])).toEqual([['gpt-5.6-sol', 50]]);
  });

  test.each([
    { contextual: true, completeLastUsage: true, rejected: 0 },
    { contextual: true, completeLastUsage: false, rejected: 1 },
    { contextual: false, completeLastUsage: true, rejected: 1 },
  ])('only clears a counter-reset warning when its usage is fully attributable: %j', ({
    contextual,
    completeLastUsage,
    rejected,
  }) => {
    const parser = createCodexSessionParser();
    const visit = (event: object) => parser.visit(JSON.stringify({ timestamp: '2026-10-01T12:00:00.000Z', ...event }));
    visit({ type: 'session_meta', payload: { id: 'reset-session' } });
    if (contextual) {
      visit({ payload: { type: 'task_started', turn_id: 'task' } });
      visit({ type: 'turn_context', payload: { turn_id: 'task', model: 'gpt-5.6-sol' } });
    }
    const usage = (input: number, cache: number, output: number) => ({
      input_tokens: input,
      cached_input_tokens: cache,
      output_tokens: output,
      total_tokens: input + output,
    });
    visit({
      payload: {
        type: 'token_count',
        info: { total_token_usage: usage(100, 60, 20), last_token_usage: usage(100, 60, 20) },
      },
    });
    const reset = {
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: usage(10, 6, 2),
          last_token_usage: completeLastUsage ? usage(10, 6, 2) : usage(5, 3, 1),
        },
      },
    };
    visit(reset);
    visit(reset); // Repeated snapshots must not double-count the recovery.
    const result = parser.finish();
    expect(result.rejectedMetricRecords).toBe(rejected);
    if (contextual && completeLastUsage) {
      expect([result.session.tin, result.session.tcr, result.session.tout]).toEqual([44, 66, 22]);
      expect(result.session.lastRejectedMetricAt).toBeUndefined();
    } else {
      expect(result.session.lastRejectedMetricAt).toBe('2026-10-01T12:00:00.000Z');
    }
  });

  test('resets cumulative token baselines without producing negative deltas', async () => {
    const storage = new TestMemoryStorage();
    const tokenEvent = (timestamp: string, total: unknown, input: unknown, cached: unknown, output: unknown) => ({
      timestamp,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            total_tokens: total,
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
          total_token_usage: {
            total_tokens: total,
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
        },
      },
    });
    storage.writeText(
      '.codex/sessions/2026/nonmono-thread.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'nonmono-thread', cwd: '/work/nonmono' },
        },
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          payload: { type: 'task_started', turn_id: 'nonmono-turn' },
        },
        {
          timestamp: '2026-01-01T00:00:01.010Z',
          type: 'turn_context',
          payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'nonmono-turn' },
        },
        tokenEvent('2026-01-01T00:00:02.000Z', 20, 15, 5, 5),
        tokenEvent('2026-01-01T00:00:03.000Z', 25, 'malformed', 6, 6),
        tokenEvent('2026-01-01T00:00:04.000Z', 8, 6, 2, 2),
        tokenEvent('2026-01-01T00:00:05.000Z', 18, 14, 4, 4),
        {
          timestamp: '2026-01-01T00:00:06.000Z',
          payload: { type: 'task_complete', turn_id: 'nonmono-turn', duration_ms: 1000 },
        },
      ),
    );

    const result = await runWithStorage(collectCodexResult, storage);
    const detail = await runWithStorage(readCodexDetailForTest('nonmono-thread'), storage);

    expect(result.rows[0]?.tokIn).toBe(20);
    expect(result.rows[0]?.tokCr).toBe(9);
    expect(result.rows[0]?.tokOut).toBe(9);
    expect(detail?.phases[0]?.tokens.total).toBe(38);
    expect(detail?.turns[0]?.tokens.total).toBe(38);
    expect(result.warnings[0]?.message).toBe('Rejected 1 malformed codex metric record(s).');
  });

  test('caches parsed Codex session files by mtime and size', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-cache-'));
    try {
      const sessionPath = path.join(home, '.codex', 'sessions', '2026', 'cached.jsonl');
      mkdirSync(path.dirname(sessionPath), { recursive: true });
      writeFileSync(
        sessionPath,
        jsonl(
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            type: 'session_meta',
            payload: { id: 'cached-thread', cwd: '/work/cache-project' },
          },
          {
            timestamp: '2026-01-01T00:01:00.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'cached-turn' },
          },
          {
            timestamp: '2026-01-01T00:01:00.010Z',
            type: 'turn_context',
            payload: { effort: 'ultra', model: 'gpt-5.6-sol', turn_id: 'cached-turn' },
          },
          {
            timestamp: '2026-01-01T00:02:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 42,
                  input_tokens: 30,
                  cached_input_tokens: 10,
                  output_tokens: 12,
                },
              },
            },
          },
          {
            timestamp: '2026-01-01T00:04:00.000Z',
            payload: { type: 'task_complete', turn_id: 'cached-turn', duration_ms: 180_000 },
          },
          {
            timestamp: '2026-01-01T00:03:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  total_tokens: 43,
                  input_tokens: 'private-invalid-cache-value',
                  cached_input_tokens: 10,
                  output_tokens: 13,
                },
              },
            },
          },
        ),
      );

      const first = await runWithRealStorage(collectCodexResult, home);
      const second = await runWithRealStorage(collectCodexResult, home);

      expect(second).toEqual(first);
      expect(second.rows[0]?.name).toBe('codex cached-thread');
      expect(second.rows[0]?.tokIn).toBe(20);
      expect(second.rows[0]?.tokCr).toBe(10);
      expect(second.rows[0]?.tokOut).toBe(12);
      expect(second.rows[0]?.durationMs).toBe(180_000);
      expect(second.rows[0]?.model).toBe('gpt-5.6-sol');
      expect(second.rows[0]?.models).toEqual(['gpt-5.6-sol']);
      expect(second.warnings).toEqual([
        {
          affectedSessions: 1,
          lastObservedAt: '2026-01-01T00:03:00.000Z',
          harness: 'codex',
          operation: 'metricValidation',
          message: 'Rejected 1 malformed codex metric record(s).',
          rejectedRecords: 1,
        },
      ]);
      expect(JSON.stringify(second.warnings)).not.toContain('private-invalid-cache-value');

      const db = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'));
      try {
        const row = db.query('SELECT count(*) as count FROM codex_session_cache').get() as { count: number };
        expect(row.count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps signal-bearing malformed JSONL completeness across cold and warm reads without dropping a valid final line', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-jsonl-cache-'));
    try {
      const sessionsDirectory = path.join(home, '.codex', 'sessions', '2026');
      mkdirSync(sessionsDirectory, { recursive: true });
      // Only the first line could have carried a skill signal — an exec read
      // charged to invocation. The truncated `turn_context` is parsed for usage
      // rows alone, and neither line is exposure evidence; letting either inflate
      // the reject count would make this read a permanent lower bound.
      writeFileSync(
        path.join(sessionsDirectory, 'invalid-only.jsonl'),
        [
          '{"timestamp":"2026-08-01T09:00:00.000Z","type":"response_item","payload":{"type":"custom_tool_call"',
          '{"timestamp":"2026-08-01T09:00:00.000Z","type":"turn_context","payload":{"cwd"',
          '{"unreadable":',
        ].join('\n'),
      );

      const finalSkillDocument = '/home/alex/.agents/skills/final-record/SKILL.md';
      writeFileSync(
        path.join(sessionsDirectory, 'valid-final-line.jsonl'),
        [
          JSON.stringify({
            payload: { cwd: '/work/cache-project', id: 'valid-final-line', originator: 'codex_cli_rs' },
            timestamp: '2026-08-01T09:00:00.000Z',
            type: 'session_meta',
          }),
          JSON.stringify({
            payload: {
              call_id: 'call_final_record',
              input: JSON.stringify({ cmd: `cat ${finalSkillDocument}` }),
              name: 'exec',
              type: 'custom_tool_call',
            },
            timestamp: '2026-08-01T09:00:01.000Z',
            type: 'response_item',
          }),
        ].join('\n'),
      );

      const cold = await runWithRealStorage(collectCodexResult, home);
      const warm = await runWithRealStorage(collectCodexResult, home);

      expect(cold.observationCompleteness).toEqual({
        exposure: { rejected: 0, truncated: false },
        invocation: { rejected: 1, truncated: false },
      });
      expect(warm.observationCompleteness).toEqual(cold.observationCompleteness);
      expect(warm.observations.map(({ skillName, tier }) => `${tier}:${skillName}`)).toEqual(['inferred:final-record']);
      const coldWarning = cold.warnings.find(({ operation }) => operation === 'skillObservationValidation');
      const warmWarning = warm.warnings.find(({ operation }) => operation === 'skillObservationValidation');
      expect(coldWarning).toMatchObject({
        message: 'Rejected 1 malformed codex skill observation record(s).',
        rejectedRecords: 1,
      });
      expect(warmWarning).toEqual(coldWarning);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps an exposure-only producer bound distinct across cold and warm cache reads', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-skill-cache-'));
    setCodexSkillObservationCeilingForTesting(1);
    try {
      const sessionPath = path.join(home, '.codex', 'sessions', '2026', 'skill-cache.jsonl');
      mkdirSync(path.dirname(sessionPath), { recursive: true });
      const malformedSkillName = 'x'.repeat(513);
      const catalogue = [
        '### Available skills',
        `- ${malformedSkillName}: Invalid bounded name.`,
        '- first: First skill. (file: /home/alex/.agents/skills/first/SKILL.md)',
        '- second: Second skill. (file: /home/alex/.agents/skills/second/SKILL.md)',
      ].join('\n');
      writeFileSync(
        sessionPath,
        jsonl(
          {
            payload: { cwd: '/work/cache-project', id: 'skill-cache-thread', originator: 'codex_cli_rs' },
            timestamp: '2026-08-01T09:00:00.000Z',
            type: 'session_meta',
          },
          {
            payload: {
              type: 'message',
              id: 'msg_developer',
              role: 'developer',
              content: [{ type: 'input_text', text: catalogue }],
            },
            timestamp: '2026-08-01T09:00:01.000Z',
            type: 'response_item',
          },
        ),
      );

      const cold = await runWithRealStorage(collectCodexResult, home);
      const warm = await runWithRealStorage(collectCodexResult, home);

      expect(cold.observationCompleteness).toEqual({
        exposure: { rejected: 1, truncated: true },
        invocation: { rejected: 0, truncated: false },
      });
      expect(warm.observationCompleteness).toEqual(cold.observationCompleteness);
      expect(warm.observations.map(({ skillName, tier }) => `${tier}:${skillName}`)).toEqual(['exposed:first']);
    } finally {
      setCodexSkillObservationCeilingForTesting(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps an invocation-only producer bound distinct across cold and warm cache reads', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-skill-cache-'));
    setCodexSkillObservationCeilingForTesting(1);
    try {
      const sessionPath = path.join(home, '.codex', 'sessions', '2026', 'skill-cache.jsonl');
      mkdirSync(path.dirname(sessionPath), { recursive: true });
      const malformedSkillName = 'x'.repeat(513);
      writeFileSync(
        sessionPath,
        jsonl(
          {
            payload: { cwd: '/work/cache-project', id: 'skill-cache-thread', originator: 'codex_cli_rs' },
            timestamp: '2026-08-01T09:00:00.000Z',
            type: 'session_meta',
          },
          {
            payload: {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'call_reads',
              input: JSON.stringify({
                cmd: `cat /home/alex/.agents/skills/${malformedSkillName}/SKILL.md /home/alex/.agents/skills/valid/SKILL.md`,
              }),
            },
            timestamp: '2026-08-01T09:00:01.000Z',
            type: 'response_item',
          },
        ),
      );

      const cold = await runWithRealStorage(collectCodexResult, home);
      const warm = await runWithRealStorage(collectCodexResult, home);

      expect(cold.observationCompleteness).toEqual({
        exposure: { rejected: 0, truncated: false },
        invocation: { rejected: 1, truncated: true },
      });
      expect(warm.observationCompleteness).toEqual(cold.observationCompleteness);
      expect(warm.observations.map(({ skillName, tier }) => `${tier}:${skillName}`)).toEqual(['inferred:valid']);
    } finally {
      setCodexSkillObservationCeilingForTesting(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('aggregates exposure and invocation producer losses independently across sessions', async () => {
    const storage = new TestMemoryStorage();
    const malformedSkillName = 'x'.repeat(513);
    storage.writeText(
      '.codex/sessions/2026/exposure-loss.jsonl',
      jsonl(
        {
          payload: { cwd: '/work/aggregate-project', id: 'exposure-loss', originator: 'codex_cli_rs' },
          timestamp: '2026-08-01T09:00:00.000Z',
          type: 'session_meta',
        },
        {
          payload: {
            type: 'message',
            id: 'msg_developer',
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: ['### Available skills', `- ${malformedSkillName}: Invalid bounded name.`].join('\n'),
              },
            ],
          },
          timestamp: '2026-08-01T09:00:01.000Z',
          type: 'response_item',
        },
      ),
    );
    storage.writeText(
      '.codex/sessions/2026/invocation-loss.jsonl',
      jsonl(
        {
          payload: { cwd: '/work/aggregate-project', id: 'invocation-loss', originator: 'codex_cli_rs' },
          timestamp: '2026-08-01T10:00:00.000Z',
          type: 'session_meta',
        },
        {
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'call_invalid_read',
            input: JSON.stringify({ cmd: `cat /home/alex/.agents/skills/${malformedSkillName}/SKILL.md` }),
          },
          timestamp: '2026-08-01T10:00:01.000Z',
          type: 'response_item',
        },
      ),
    );

    const result = await runWithStorage(collectCodexResult, storage);

    expect(result.observationCompleteness).toEqual({
      exposure: { rejected: 1, truncated: false },
      invocation: { rejected: 1, truncated: false },
    });
    expect(result.warnings.find(({ operation }) => operation === 'skillObservationValidation')?.rejectedRecords).toBe(
      2,
    );
  });

  /**
   * The regression this guards: a Codex rollout carrying a pasted image as one
   * base64 record used to fail the read, and because the collector reads every
   * rollout in one pass, that single record took the whole Codex source down —
   * every session on the machine stopped being collected.
   */
  test('drops an oversized record, still collects its session, and reports the loss', async () => {
    const storage = new NarrowLineBudgetCodexStorage();
    storage.writeText(
      '.codex/sessions/2026/oversized.jsonl',
      jsonl(
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'oversized-thread', cwd: '/work/fixture-project' },
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          payload: { type: 'task_started', turn_id: 'oversized-turn' },
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-6-astra', turn_id: 'oversized-turn' },
        },
        {
          timestamp: '2026-01-01T00:03:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(2048)}` }],
          },
        },
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 30,
                input_tokens: 12,
                cached_input_tokens: 2,
                output_tokens: 18,
              },
            },
          },
        },
      ),
    );

    const result = await runWithStorage(collectCodexResult, storage);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.model).toBe('gpt-6-astra');
    expect(result.rows[0]?.tokOut).toBe(18);
    expect(result.rows[0]?.turns).toBe(1);
    expect(result.warnings.find(({ operation }) => operation === 'oversizedHistoryLine')).toMatchObject({
      harness: 'codex',
      rejectedRecords: 1,
    });
  });

  test('prices a task that switched models like its phases and reports turns past the budget', async () => {
    const storage = new TestMemoryStorage();
    const tokenCount = (timestamp: string, total: number, input: number, output: number) => ({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            total_tokens: total,
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
          },
        },
      },
    });
    storage.writeText(
      '.codex/sessions/2026/rollout-2026-01-01T00-00-00-switch-thread.jsonl',
      jsonl(
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'switch-thread', cwd: '/work' } },
        { timestamp: '2026-01-01T00:01:00.000Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
        {
          timestamp: '2026-01-01T00:01:00.010Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: 'turn-1' },
        },
        {
          timestamp: '2026-01-01T00:01:00.040Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Switch' },
        },
        tokenCount('2026-01-01T00:02:00.000Z', 1000, 1000, 0),
        {
          timestamp: '2026-01-01T00:02:30.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', turn_id: 'turn-1' },
        },
        tokenCount('2026-01-01T00:03:00.000Z', 2000, 2000, 0),
        { timestamp: '2026-01-01T00:04:00.000Z', payload: { type: 'task_complete', turn_id: 'turn-1' } },
      ),
    );
    const detail = await runWithStorage(readCodexDetailForTest('switch-thread'), storage);
    expect(detail?.turns).toHaveLength(1);
    const phaseCost = detail?.phases.reduce((total, phase) => total + (phase.cost ?? 0), 0) ?? Number.NaN;
    expect(detail?.turns[0]?.costKind).toBe('approximate');
    expect(detail?.turns[0]?.cost).toBeCloseTo(phaseCost, 10);
    expect(detail?.turns[0]?.calls).toBeNull();

    const busy = new TestMemoryStorage();
    const events: unknown[] = [
      { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'busy-thread', cwd: '/work' } },
    ];
    const base = Date.parse('2026-01-01T00:01:00.000Z');
    for (let index = 0; index < 1025; index += 1) {
      const start = new Date(base + index * 10_000);
      events.push(
        { timestamp: start.toISOString(), payload: { type: 'task_started', turn_id: `turn-${index}` } },
        {
          timestamp: new Date(start.getTime() + 10).toISOString(),
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', turn_id: `turn-${index}` },
        },
        {
          timestamp: new Date(start.getTime() + 20).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: `Prompt ${index}` },
        },
        {
          timestamp: new Date(start.getTime() + 5000).toISOString(),
          payload: { type: 'task_complete', turn_id: `turn-${index}` },
        },
      );
    }
    busy.writeText('.codex/sessions/2026/rollout-2026-01-01T00-00-00-busy-thread.jsonl', jsonl(...events));
    const busyDetail = await runWithStorage(readCodexDetailForTest('busy-thread'), busy);
    expect(busyDetail?.turns).toHaveLength(1024);
    expect(busyDetail?.coverage.grouping).toEqual({ omittedCount: 1, reasons: ['turn-budget'], status: 'partial' });
    expect(busyDetail?.coverage.promptBodies).toEqual({
      omittedCount: 1,
      reasons: ['prompt-body-budget', 'prompt-budget'],
      status: 'partial',
    });
    expect(busyDetail).not.toBeNull();
    expect(parseSessionDetail(busyDetail)).toEqual(busyDetail as SessionDetail);
  });
});

describe('Codex child token ownership', () => {
  const birth = '2026-01-01T00:10:00.000Z';
  const written = '2026-01-01T00:10:05.000Z';
  const start = 1_767_226_200;
  const event = (type: string, payload: Record<string, unknown>, timestamp = written) => ({
    timestamp,
    type,
    payload,
  });
  const task = (turn: string, startedAt: number | undefined = start) =>
    event('event_msg', { type: 'task_started', turn_id: turn, started_at: startedAt });
  const context = (turn: string) => event('turn_context', { turn_id: turn, model: 'gpt-5.6-sol' });
  const counts = (total: number) => ({
    input_tokens: total * 0.8,
    cached_input_tokens: total * 0.6,
    output_tokens: total * 0.2,
    total_tokens: total,
  });
  const tokens = (total: number, last?: number) =>
    event('event_msg', {
      type: 'token_count',
      info: { total_token_usage: counts(total), ...(last === undefined ? {} : { last_token_usage: counts(last) }) },
    });
  const complete = (turn: string, startedAt?: number, completedAt = start + 60) =>
    event('event_msg', { type: 'task_complete', turn_id: turn, started_at: startedAt, completed_at: completedAt });
  const read = async (events: unknown[], metadata: Record<string, unknown> = {}) => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/ownership-child.jsonl',
      jsonl(
        event('session_meta', {
          id: 'ownership-child',
          timestamp: birth,
          cwd: '/work/ownership',
          source: { subagent: { thread_spawn: { parent_thread_id: 'ownership-parent' } } },
          ...metadata,
        }),
        ...events,
      ),
    );
    const session = (await runWithStorage(readCodexUsageSessions, storage))[0];
    const analysis = await runWithStorage(readCodexSessionAnalysis('ownership-child'), storage);
    if (!(session && analysis)) {
      throw new Error('Expected the child session and its analysis');
    }
    const { projectPath: _projectPath, source: _source, ...row } = sessionToUsageRow(session);
    return {
      session,
      detail: analysis.detail,
      projection: analysis.projection,
      reportProjection: sessionProjectionFactsForSerializedRow(serializeUsageRow(row)),
      total: session.tokens.in + session.tokens.cr + session.tokens.out,
    };
  };

  test.each(['subagent', 'classifier'])('uses the declared birth of a delayed %s', async (origin) => {
    const { session, total, detail } = await read(
      [task('own'), context('own'), tokens(100, 100), tokens(250, 150), complete('own')],
      origin === 'classifier' ? { source: { subagent: { other: 'guardian' } } } : {},
    );
    expect(total).toBe(250);
    expect(session.partial).toBe(false);
    expect(detail.turns.map((turn) => turn.tokens.total)).toEqual([250]);
  });

  test('never falls back to the largest inherited cumulative counter', async () => {
    const { session, total } = await read([
      task('parent-turn', start - 120),
      context('parent-turn'),
      tokens(1000, 100),
      complete('parent-turn', start - 120, start - 60),
    ]);
    expect(total).toBe(0);
    // Counters seen without any child-owned generation are unproven, not zero usage.
    expect(session.partial).toBe(true);
  });

  test('does not move the child birth backwards when copied records retain parent timestamps', async () => {
    const parentTime = '2026-01-01T00:00:00.000Z';
    const { total } = await read([
      event('session_meta', { id: 'ownership-parent', timestamp: parentTime }, parentTime),
      event('event_msg', { type: 'task_started', turn_id: 'parent-turn', started_at: start - 600 }, parentTime),
      context('parent-turn'),
      tokens(1000, 1000),
      tokens(1100, 100),
      complete('parent-turn', start - 600, start - 60),
      task('own'),
      context('own'),
      tokens(1200, 100),
      complete('own'),
    ]);
    expect(total).toBe(100);
  });

  test('recovers an unanchored classifier generation from its recorded completion start', async () => {
    const { total, detail, projection, reportProjection } = await read(
      [
        tokens(1000),
        task('rollout-2'),
        context('first'),
        tokens(1100, 100),
        complete('first', start + 10),
        complete('rollout-2'),
        task('second', start + 61),
        context('second'),
        tokens(1250, 150),
        complete('second', start + 61, start + 90),
      ],
      { source: { subagent: { other: 'guardian' } }, subagent_history_start_ordinal: 12 },
    );
    expect(total).toBe(250);
    expect(detail.phases.reduce((sum, phase) => sum + phase.tokens.total, 0)).toBe(250);
    expect(projection).toEqual(reportProjection);
  });

  test('keeps a recovered generation in the detail when the next native turn changes model', async () => {
    const { total, detail, projection, reportProjection } = await read(
      [
        tokens(1000),
        task('rollout-2'),
        context('first'),
        tokens(1100, 100),
        complete('first', start + 10),
        complete('rollout-2'),
        task('second', start + 61),
        event('turn_context', { turn_id: 'second', model: 'gpt-5.6-terra' }),
        tokens(1200, 100),
        complete('second', start + 61, start + 90),
      ],
      { source: { subagent: { other: 'guardian' } }, subagent_history_start_ordinal: 12 },
    );
    expect(total).toBe(200);
    expect(detail.phases.map((phase) => [phase.model, phase.tokens.total])).toEqual([
      ['gpt-5.6-sol', 100],
      ['gpt-5.6-terra', 100],
    ]);
    expect(detail.phases[0]?.startAt).toBe(new Date((start + 10) * 1000).toISOString());
    expect(projection).toEqual(reportProjection);
  });

  test('keeps an inherited task context out of a pending unanchored generation', async () => {
    const { total } = await read([
      task('parent-turn', start - 600),
      context('first'),
      tokens(1000),
      context('parent-turn'),
      tokens(1100, 100),
      complete('first', start + 10),
      complete('parent-turn', start - 600, start - 60),
    ]);
    expect(total).toBe(0);
  });

  test('attributes a turn context without a turn id to the open owned task', async () => {
    const { session, total } = await read([
      task('own'),
      event('turn_context', { model: 'gpt-5.6-sol' }),
      tokens(100, 100),
      tokens(250, 150),
      complete('own'),
    ]);
    expect(total).toBe(250);
    expect(session.partial).toBe(false);
  });
  test('recovers a paginated child context preceding its synthetic task wrapper', async () => {
    const { total } = await read(
      [
        context('first'),
        tokens(1000),
        task('rollout-4'),
        tokens(1100, 100),
        tokens(1250, 150),
        complete('first', start + 10),
        complete('rollout-4'),
      ],
      { forked_from_id: 'ownership-parent', subagent_history_start_ordinal: 8 },
    );
    expect(total).toBe(250);
  });

  test('keeps the synthetic wrapper of a copied parent context out of child usage', async () => {
    const { total, session } = await read(
      [
        context('parent-turn'),
        tokens(1000),
        task('rollout-4'),
        tokens(1100, 100),
        complete('parent-turn', undefined, start - 60),
        complete('rollout-4'),
        task('own'),
        context('own'),
        tokens(1200, 100),
        complete('own'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(100);
    expect(session.partial).toBe(false);
  });

  test('counts an owned generation without requiring a turn context', async () => {
    const { session, total } = await read([tokens(1000), task('own'), tokens(1100, 100), complete('own')]);
    expect(total).toBe(100);
    // The seed before the first native task may hold earlier child usage.
    expect(session.partial).toBe(true);
  });

  test('reports token growth outside an attributable task instead of silently dropping it', async () => {
    const { total, session } = await read([
      task('own'),
      context('own'),
      tokens(100, 100),
      complete('own'),
      tokens(250, 150),
    ]);
    expect(total).toBe(100);
    expect(session.partial).toBe(true);
  });

  test('does not infer a zero baseline merely from the absence of a fork marker', async () => {
    const { total, session } = await read([
      task('own'),
      context('own'),
      tokens(1000),
      tokens(1100, 100),
      complete('own'),
    ]);
    expect(total).toBe(100);
    expect(session.partial).toBe(true);
  });

  test('marks a first cumulative counter with missing earlier generations partial', async () => {
    const { total, session } = await read([
      task('own'),
      context('own'),
      tokens(1000, 100),
      tokens(1150, 150),
      complete('own'),
    ]);
    expect(total).toBe(250);
    expect(session.partial).toBe(true);
  });

  test('marks an unresolved unanchored context partial instead of publishing its cumulative total', async () => {
    const { session, total } = await read(
      [
        context('unplaced'),
        tokens(1000),
        task('rollout-4'),
        tokens(1100, 100),
        complete('unplaced'),
        complete('rollout-4'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(0);
    expect(session.partial).toBe(true);
  });

  test('does not assume an initial inherited cumulative snapshot belongs to the child', async () => {
    const { session, total } = await read(
      [task('own'), context('own'), tokens(1000), tokens(1100, 100), complete('own')],
      {
        forked_from_id: 'ownership-parent',
      },
    );
    expect(total).toBe(100);
    expect(session.partial).toBe(true);
  });

  test('counts the last generation after a reset once and reports the missing epoch', async () => {
    const { session, total } = await read(
      [
        tokens(1000),
        task('own'),
        context('own'),
        tokens(1100, 100),
        tokens(300, 50),
        tokens(300, 50),
        tokens(400, 100),
        complete('own'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(250);
    expect(session.partial).toBe(true);
  });

  test.each([
    { resetLast: 40, partial: false, expected: 190 },
    { resetLast: 30, partial: true, expected: 180 },
  ])('only treats an owned reset as complete when its snapshot is the last generation: %j', async ({
    resetLast,
    partial,
    expected,
  }) => {
    const { session, total } = await read([
      task('own'),
      context('own'),
      tokens(100, 100),
      tokens(40, resetLast),
      tokens(40, resetLast),
      tokens(90, 50),
      complete('own'),
    ]);
    expect(total).toBe(expected);
    expect(session.partial).toBe(partial);
  });

  test('rejects an inconsistent last usage as evidence of an owned generation', async () => {
    const { session, total } = await read(
      [
        task('own'),
        context('own'),
        event('event_msg', {
          type: 'token_count',
          info: { total_token_usage: counts(1000), last_token_usage: { ...counts(0), total_tokens: 100 } },
        }),
        tokens(1100, 100),
        complete('own'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(100);
    expect(session.partial).toBe(true);
  });

  test('keeps a paginated baseline before the first context out of classifier usage', async () => {
    const { total, session } = await read(
      [
        task('own'),
        event('event_msg', {
          type: 'token_count',
          info: { total_token_usage: counts(1000), last_token_usage: { ...counts(0), total_tokens: 100 } },
        }),
        context('own'),
        tokens(1100, 100),
        complete('own'),
      ],
      { source: { subagent: { other: 'guardian' } }, subagent_history_start_ordinal: 5 },
    );
    expect(total).toBe(100);
    expect(session.partial).toBe(true);
  });

  test('uses recorded completion duration to locate an unanchored generation', async () => {
    const { total } = await read(
      [
        context('first'),
        tokens(1000),
        task('rollout-4'),
        tokens(1100, 100),
        event('event_msg', { type: 'task_complete', turn_id: 'first', completed_at: start + 60, duration_ms: 50_000 }),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(100);
  });

  test('does not certify replay-time task starts without an original timestamp', async () => {
    const { total, session } = await read(
      [
        event('event_msg', { type: 'task_started', turn_id: 'uncertain' }),
        context('uncertain'),
        tokens(1000, 100),
        tokens(1100, 100),
        complete('uncertain'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(0);
    expect(session.partial).toBe(true);
  });

  test('does not duplicate a reset generation on a quota-only or repeated snapshot', async () => {
    const { total } = await read(
      [
        tokens(1000),
        task('own'),
        context('own'),
        tokens(1100, 100),
        event('event_msg', { type: 'token_count', info: null, rate_limits: {} }),
        tokens(1100, 100),
        tokens(50, 50),
        tokens(50, 50),
        tokens(150, 100),
        complete('own'),
      ],
      { forked_from_id: 'ownership-parent' },
    );
    expect(total).toBe(250);
  });

  test('preserves child token ownership and partial status across cache reads', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-child-cache-'));
    try {
      const file = path.join(home, '.codex/sessions/2026/child.jsonl');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        jsonl(
          event('session_meta', {
            id: 'cached-child',
            timestamp: birth,
            source: { subagent: { other: 'guardian' } },
            subagent_history_start_ordinal: 7,
          }),
          tokens(1000),
          task('rollout-2'),
          context('first'),
          tokens(1100, 100),
          complete('first', start + 10),
          complete('rollout-2'),
        ),
      );
      const cold = await runWithRealStorage(collectCodexResult, home);
      const warm = await runWithRealStorage(collectCodexResult, home);
      expect(warm).toEqual(cold);
      expect(warm.rows[0]).toMatchObject({ tokIn: 20, tokCr: 60, tokOut: 20, partial: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Codex compresses finished rollouts in place (`.jsonl` → `.jsonl.zst`) and
 * moves archived threads to the flat `archived_sessions` directory. Both forms
 * are rollouts of the same shape and must produce the same rows.
 */
describe('Codex compressed rollouts', () => {
  const rolloutEvents = (id: string, turns: number): unknown[] => {
    const events: unknown[] = [
      { timestamp: '2026-09-01T08:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/work/archive' } },
    ];
    for (let turn = 1; turn <= turns; turn++) {
      const minute = String(turn * 2).padStart(2, '0');
      events.push(
        { timestamp: `2026-09-01T08:${minute}:00.000Z`, payload: { type: 'task_started', turn_id: `turn-${turn}` } },
        {
          timestamp: `2026-09-01T08:${minute}:00.100Z`,
          type: 'turn_context',
          payload: { effort: 'high', model: 'gpt-5.6-sol', turn_id: `turn-${turn}` },
        },
        {
          timestamp: `2026-09-01T08:${minute}:30.000Z`,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                total_tokens: 42 * turn,
                input_tokens: 30 * turn,
                cached_input_tokens: 10 * turn,
                output_tokens: 12 * turn,
              },
            },
          },
        },
        {
          timestamp: `2026-09-01T08:${minute}:59.000Z`,
          payload: { type: 'task_complete', turn_id: `turn-${turn}`, duration_ms: 59_000 },
        },
      );
    }
    return events;
  };
  const archive = (...events: unknown[]) => Bun.zstdCompressSync(jsonl(...events));
  const rowFor = (result: { rows: ReturnType<typeof sessionToUsageRow>[] }, sourceSessionId: string) => {
    const row = result.rows.find((candidate) => candidate.source?.sourceSessionId === sourceSessionId);
    if (!row) {
      throw new Error(`Expected a row for ${sourceSessionId}`);
    }
    return row;
  };
  const idFreeFacts = (row: ReturnType<typeof sessionToUsageRow>) => {
    const { name: _name, source: _source, ...facts } = row;
    return facts;
  };

  test('keeps one file per rollout stem, plain over archive and active over archived', () => {
    const sessionsDir = '/home/test/.codex/sessions';
    const resolved = resolveCodexRolloutFiles(
      [
        '/home/test/.codex/archived_sessions/rollout-a.jsonl.zst',
        '/home/test/.codex/sessions/2026/09/01/rollout-a.jsonl.zst',
        '/home/test/.codex/sessions/2026/09/01/rollout-b.jsonl.zst',
        '/home/test/.codex/sessions/2026/09/01/rollout-b.jsonl',
        '/home/test/.codex/archived_sessions/rollout-c.jsonl',
        '/home/test/.codex/sessions/2026/09/01/rollout-c.jsonl.zst',
        '/home/test/.codex/archived_sessions/rollout-d.jsonl.zst',
        '/home/test/.codex/sessions/2026/09/02/rollout-e.jsonl',
        '/home/test/.codex/sessions/2026/09/01/rollout-e.jsonl',
      ],
      sessionsDir,
    );
    expect(resolved).toEqual([
      '/home/test/.codex/archived_sessions/rollout-c.jsonl',
      '/home/test/.codex/archived_sessions/rollout-d.jsonl.zst',
      '/home/test/.codex/sessions/2026/09/01/rollout-a.jsonl.zst',
      '/home/test/.codex/sessions/2026/09/01/rollout-b.jsonl',
      '/home/test/.codex/sessions/2026/09/01/rollout-e.jsonl',
    ]);
  });

  test('discovers plain, compressed and archived rollouts and reads the plain form of a stem present in both', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/sessions/2026/09/01/rollout-plain.jsonl', jsonl(...rolloutEvents('plain-thread', 1)));
    storage.writeBytes(
      '.codex/sessions/2026/09/01/rollout-compressed.jsonl.zst',
      archive(...rolloutEvents('compressed-thread', 1)),
    );
    storage.writeBytes(
      '.codex/archived_sessions/rollout-archived.jsonl.zst',
      archive(...rolloutEvents('archived-thread', 1)),
    );
    // The plain file carries one more turn than its archive: Codex writes the
    // archive first and removes the source last, so the plain file is the
    // writer's authoritative form.
    storage.writeText('.codex/sessions/2026/09/01/rollout-both.jsonl', jsonl(...rolloutEvents('both-thread', 2)));
    storage.writeBytes(
      '.codex/sessions/2026/09/01/rollout-both.jsonl.zst',
      archive(...rolloutEvents('both-thread', 1)),
    );

    const result = await runWithStorage(collectCodexResult, storage);
    expect(result.warnings).toEqual([]);
    expect(result.rows.map((row) => row.source?.sourceSessionId).sort()).toEqual([
      'archived-thread',
      'both-thread',
      'compressed-thread',
      'plain-thread',
    ]);
    expect(rowFor(result, 'both-thread')).toMatchObject({ turns: 2, tokOut: 24 });
    expect(rowFor(result, 'archived-thread')).toMatchObject({ turns: 1, tokOut: 12 });
    expect(idFreeFacts(rowFor(result, 'compressed-thread'))).toEqual(idFreeFacts(rowFor(result, 'plain-thread')));
  });

  test('skips a corrupt archive when looking for the latest quota snapshot and fails when nothing else is read', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText(
      '.codex/sessions/2026/09/01/rollout-2026-09-01-quota.jsonl',
      jsonl(...rolloutEvents('quota-thread', 1), {
        timestamp: '2026-09-01T08:05:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 42, input_tokens: 30, cached_input_tokens: 10, output_tokens: 12 },
          },
          rate_limits: { plan_type: 'pro', primary: { used_percent: 37, window_minutes: 300 } },
        },
      }),
    );
    // Sorts after the plain rollout, so the newest-first search reads it first
    // and must step over it to reach the snapshot.
    storage.writeBytes('.codex/sessions/2026/09/02/rollout-2026-09-02-corrupt.jsonl.zst', Buffer.alloc(48, 0xff));

    const quota = await runWithStorage(findLatestCodexQuotaSnapshot(), storage);
    expect(quota?.planType).toBe('pro');
    expect(quota?.primary?.usedPercent).toBe(37);
    expect(quota?.primary?.windowMinutes).toBe(300);
    expect(await runWithStorage(findLatestCodexProviderStatus(), storage)).toMatchObject({ key: 'codex', state: 'ok' });

    // With nothing else read, "no snapshot" would claim an absence the reader
    // could not observe, so the skipped archive's failure is the answer.
    const corruptOnly = new TestMemoryStorage();
    corruptOnly.writeBytes('.codex/sessions/2026/09/02/rollout-2026-09-02-corrupt.jsonl.zst', Buffer.alloc(48, 0xff));
    const quotaRead = await runWithStorage(Effect.either(findLatestCodexQuotaSnapshot()), corruptOnly);
    const statusRead = await runWithStorage(Effect.either(findLatestCodexProviderStatus()), corruptOnly);
    for (const read of [quotaRead, statusRead]) {
      expect(read._tag).toBe('Left');
      if (read._tag === 'Left') {
        expect(read.left).toMatchObject({
          operation: 'readLines.decompress',
          path: path.join(corruptOnly.home, '.codex/sessions/2026/09/02/rollout-2026-09-02-corrupt.jsonl.zst'),
        });
      }
    }

    const empty = new TestMemoryStorage();
    empty.writeText('.codex/sessions/2026/09/01/rollout-2026-09-01-plain.jsonl', jsonl(...rolloutEvents('plain', 1)));
    expect(await runWithStorage(findLatestCodexQuotaSnapshot(), empty)).toBeNull();
  });

  test('fails the latest quota snapshot on a read failure other than a corrupt or vanished rollout', async () => {
    class DeniedRolloutStorage extends TestMemoryStorage {
      override readLines(
        filePath: string,
        visit: (line: string) => void,
        limits: { maxBytes?: number; maxLineBytes?: number } = {},
      ) {
        return filePath.endsWith('denied.jsonl')
          ? Effect.fail(
              new LocalHistoryError({ operation: 'readLines', path: filePath, cause: new Error('Permission denied') }),
            )
          : super.readLines(filePath, visit, limits);
      }
    }
    const storage = new DeniedRolloutStorage();
    storage.writeText(
      '.codex/sessions/2026/09/01/rollout-2026-09-01-quota.jsonl',
      jsonl({
        timestamp: '2026-09-01T08:05:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', rate_limits: { plan_type: 'pro', primary: { used_percent: 37 } } },
      }),
    );
    storage.writeText('.codex/sessions/2026/09/02/rollout-2026-09-02-denied.jsonl', jsonl(...rolloutEvents('d', 1)));

    const read = await runWithStorage(Effect.either(findLatestCodexQuotaSnapshot()), storage);
    expect(read._tag).toBe('Left');
    if (read._tag === 'Left') {
      expect(read.left).toMatchObject({ operation: 'readLines' });
      expect(read.left.path?.endsWith('rollout-2026-09-02-denied.jsonl')).toBe(true);
    }
  });

  test('reads the session detail of a rollout that exists only as an archive', async () => {
    const events = rolloutEvents('detail-thread', 2);
    const compressedStorage = new TestMemoryStorage();
    compressedStorage.writeBytes(
      '.codex/sessions/2026/09/01/rollout-2026-09-01T08-00-00-detail-thread.jsonl.zst',
      archive(...events),
    );
    const plainStorage = new TestMemoryStorage();
    plainStorage.writeText(
      '.codex/sessions/2026/09/01/rollout-2026-09-01T08-00-00-detail-thread.jsonl',
      jsonl(...events),
    );

    const compressedDetail = requireSessionDetail(
      await runWithStorage(readCodexDetailForTest('detail-thread'), compressedStorage),
    );
    const plainDetail = requireSessionDetail(
      await runWithStorage(readCodexDetailForTest('detail-thread'), plainStorage),
    );
    expect(compressedDetail.turns).toHaveLength(2);
    // `observedAt` is the generation time of each read, not a fact about the rollout.
    const { observedAt: _compressedObservedAt, ...compressedFacts } = compressedDetail;
    const { observedAt: _plainObservedAt, ...plainFacts } = plainDetail;
    expect(compressedFacts).toEqual(plainFacts);
  });

  test('skips a corrupt archive with a warning and keeps collecting the rollouts beside it', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/sessions/2026/09/01/rollout-valid.jsonl', jsonl(...rolloutEvents('valid-thread', 1)));
    storage.writeBytes('.codex/sessions/2026/09/01/rollout-corrupt.jsonl.zst', Buffer.alloc(48, 0xff));

    const result = await runWithStorage(collectCodexResult, storage);
    expect(result.rows.map((row) => row.source?.sourceSessionId)).toEqual(['valid-thread']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      harness: 'codex',
      operation: 'unreadableHistoryFile',
      path: path.join(storage.home, '.codex/sessions/2026/09/01/rollout-corrupt.jsonl.zst'),
      rejectedRecords: 1,
    });
    expect(result.warnings[0]?.message).toContain('Skipped 1 codex history file(s)');
    expect(result.warnings[0]?.message).toContain('readLines.decompress');
    // The skipped rollout is missing evidence for both skill tiers, so neither
    // bound may be persisted as complete.
    expect(result.observationCompleteness).toEqual({
      exposure: { rejected: 1, truncated: false },
      invocation: { rejected: 1, truncated: false },
    });
  });

  test('aggregates several unreadable rollouts into one warning that keeps the typed list', async () => {
    const storage = new TestMemoryStorage();
    storage.writeText('.codex/sessions/2026/09/01/rollout-valid.jsonl', jsonl(...rolloutEvents('valid-thread', 1)));
    storage.writeBytes('.codex/sessions/2026/09/01/rollout-corrupt-a.jsonl.zst', Buffer.alloc(48, 0xff));
    storage.writeBytes('.codex/sessions/2026/09/01/rollout-corrupt-b.jsonl.zst', Buffer.alloc(48, 0xff));

    const result = await runWithStorage(collectCodexResult, storage);
    expect(result.rows.map((row) => row.source?.sourceSessionId)).toEqual(['valid-thread']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      harness: 'codex',
      operation: 'unreadableHistoryFile',
      path: path.join(storage.home, '.codex/sessions/2026/09/01/rollout-corrupt-a.jsonl.zst'),
      rejectedRecords: 2,
    });
    expect(result.warnings[0]?.message).toContain('Skipped 2 codex history file(s)');
    expect(result.observationCompleteness).toEqual({
      exposure: { rejected: 2, truncated: false },
      invocation: { rejected: 2, truncated: false },
    });

    const sessions = await runWithStorage(readCodexUsageSessionsResult, storage);
    expect(sessions.readFailures).toHaveLength(2);
    expect(sessions.readFailures.map((failure) => failure.operation)).toEqual([
      'readLines.decompress',
      'readLines.decompress',
    ]);
    expect(sessions.readFailures.map((failure) => path.basename(failure.path ?? ''))).toEqual([
      'rollout-corrupt-a.jsonl.zst',
      'rollout-corrupt-b.jsonl.zst',
    ]);
  });

  test('serves an unchanged archive from the cache and reports a changed one that no longer decompresses', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-archive-cache-'));
    try {
      const sessionsDirectory = path.join(home, '.codex', 'sessions', '2026', '09', '01');
      mkdirSync(sessionsDirectory, { recursive: true });
      const archivePath = path.join(sessionsDirectory, 'rollout-cached.jsonl.zst');
      const compressed = archive(...rolloutEvents('cached-archive-thread', 2));
      const originalMtime = new Date('2026-09-01T09:00:00.000Z');
      writeFileSync(archivePath, compressed);
      utimesSync(archivePath, originalMtime, originalMtime);

      const first = await runWithRealStorage(collectCodexResult, home);
      expect(first.warnings).toEqual([]);
      expect(first.rows.map((row) => row.source?.sourceSessionId)).toEqual(['cached-archive-thread']);
      expect(first.rows[0]).toMatchObject({ turns: 2, tokOut: 24 });

      // Same size and mtime, different bytes: the cache key still matches, so
      // the garbage is served from the cache and never decompressed.
      writeFileSync(archivePath, Buffer.alloc(compressed.length, 0));
      utimesSync(archivePath, originalMtime, originalMtime);
      const second = await runWithRealStorage(collectCodexResult, home);
      expect(second.rows).toEqual(first.rows);
      expect(second.warnings).toEqual([]);

      const bumpedMtime = new Date('2026-09-01T10:00:00.000Z');
      utimesSync(archivePath, bumpedMtime, bumpedMtime);
      const third = await runWithRealStorage(collectCodexResult, home);
      expect(third.rows).toEqual([]);
      expect(third.warnings).toHaveLength(1);
      expect(third.warnings[0]).toMatchObject({
        harness: 'codex',
        operation: 'unreadableHistoryFile',
        path: archivePath,
        rejectedRecords: 1,
      });
      expect(third.warnings[0]?.path?.endsWith('rollout-cached.jsonl.zst')).toBe(true);
      expect(third.warnings[0]?.message).toContain('readLines.decompress');
      expect(third.observationCompleteness).toEqual({
        exposure: { rejected: 1, truncated: false },
        invocation: { rejected: 1, truncated: false },
      });

      const db = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'));
      try {
        const row = db
          .query('SELECT count(*) as count FROM codex_session_cache WHERE file_path = ?')
          .get(archivePath) as { count: number };
        expect(row.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * Codex compresses or archives a rollout and removes the listed file while
   * the scan is reading it: the first read of a registered path visits every
   * line, then `move` runs and the read fails as the file is gone.
   */
  class MovingRolloutStorage extends TestMemoryStorage {
    private readonly moves = new Map<string, () => void>();

    moveOnRead(relativePath: string, move: () => void): void {
      this.moves.set(path.join(this.home, relativePath), move);
    }

    override readLines(
      filePath: string,
      visit: (line: string) => void,
      limits: { maxBytes?: number; maxLineBytes?: number } = {},
    ) {
      const move = this.moves.get(filePath);
      if (!move) {
        return super.readLines(filePath, visit, limits);
      }
      this.moves.delete(filePath);
      const read = super.readLines(filePath, visit, limits);
      return read.pipe(
        Effect.flatMap(() => {
          move();
          return super.readLines(filePath, visit, limits);
        }),
      );
    }
  }

  test('follows a rollout compressed or archived after the listing to its new form, counted once', async () => {
    const storage = new MovingRolloutStorage();
    const day = '.codex/sessions/2026/09/01';
    storage.writeText(`${day}/rollout-compressed-race.jsonl`, jsonl(...rolloutEvents('compressed-race', 2)));
    // Codex writes the archive first and removes the plain file last, so the
    // sibling exists when the listing prefers the plain file.
    storage.writeBytes(`${day}/rollout-compressed-race.jsonl.zst`, archive(...rolloutEvents('compressed-race', 2)));
    storage.moveOnRead(`${day}/rollout-compressed-race.jsonl`, () =>
      storage.remove(`${day}/rollout-compressed-race.jsonl`),
    );
    storage.writeText(`${day}/rollout-archived-race.jsonl`, jsonl(...rolloutEvents('archived-race', 1)));
    storage.moveOnRead(`${day}/rollout-archived-race.jsonl`, () => {
      storage.remove(`${day}/rollout-archived-race.jsonl`);
      storage.writeBytes(
        '.codex/archived_sessions/rollout-archived-race.jsonl.zst',
        archive(...rolloutEvents('archived-race', 1)),
      );
    });

    const result = await runWithStorage(collectCodexResult, storage);
    expect(result.warnings).toEqual([]);
    expect(result.observationCompleteness).toEqual({
      exposure: { rejected: 0, truncated: false },
      invocation: { rejected: 0, truncated: false },
    });
    // The failed attempt had visited every line; a fresh parser per attempt
    // keeps them from being counted twice.
    expect(rowFor(result, 'compressed-race')).toMatchObject({ turns: 2, tokOut: 24 });
    expect(rowFor(result, 'archived-race')).toMatchObject({ turns: 1, tokOut: 12 });
  });

  test('counts a rollout that vanished in every form as unreadable', async () => {
    const storage = new MovingRolloutStorage();
    storage.writeText('.codex/sessions/2026/09/01/rollout-kept.jsonl', jsonl(...rolloutEvents('kept', 1)));
    storage.writeText('.codex/sessions/2026/09/01/rollout-gone.jsonl', jsonl(...rolloutEvents('gone', 1)));
    storage.moveOnRead('.codex/sessions/2026/09/01/rollout-gone.jsonl', () =>
      storage.remove('.codex/sessions/2026/09/01/rollout-gone.jsonl'),
    );

    const result = await runWithStorage(readCodexUsageSessionsResult, storage);
    expect(result.sessions.map((session) => session.source.sourceSessionId)).toEqual(['kept']);
    expect(result.readFailures).toHaveLength(1);
    expect(result.readFailures[0]).toMatchObject({
      operation: 'readLines',
      path: path.join(storage.home, '.codex/sessions/2026/09/01/rollout-gone.jsonl'),
    });
  });

  test('holds back a root-owned child while its root rollout is unreadable instead of flipping its ownership', async () => {
    const usage = (total: number) => ({
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: 10, input_tokens: 8, cached_input_tokens: 6, output_tokens: 2 },
        total_token_usage: {
          total_tokens: total,
          input_tokens: (total * 8) / 10,
          cached_input_tokens: (total * 6) / 10,
          output_tokens: (total * 2) / 10,
        },
      },
    });
    const rootEvents = [
      { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'own-root', cwd: '/work/own' } },
      { timestamp: '2026-01-01T00:01:00.000Z', payload: usage(10) },
      { timestamp: '2026-01-01T00:10:00.000Z', payload: usage(100) },
    ];
    const childEvents = (id: string, parent: string) => [
      {
        timestamp: '2026-01-01T00:02:00.000Z',
        type: 'session_meta',
        payload: { id, cwd: '/work/own', source: { subagent: { thread_spawn: { parent_thread_id: parent } } } },
      },
      {
        timestamp: '2026-01-01T00:02:00.000Z',
        type: 'session_meta',
        payload: { id: parent, cwd: '/work/own', source: 'vscode' },
      },
      { timestamp: '2026-01-01T00:03:00.000Z', payload: usage(50) },
    ];
    const day = '.codex/sessions/2026/01/01';
    const rootPath = `${day}/rollout-2026-01-01T00-00-00-own-root.jsonl.zst`;
    const childPath = `${day}/rollout-2026-01-01T00-02-00-own-child.jsonl`;
    const orphanPath = `${day}/rollout-2026-01-01T00-02-00-orphan-child.jsonl`;

    const readable = new TestMemoryStorage();
    readable.writeBytes(rootPath, archive(...rootEvents));
    readable.writeText(childPath, jsonl(...childEvents('own-child', 'own-root')));
    const baseline = await runWithStorage(collectCodexResult, readable);
    expect(baseline.warnings).toEqual([]);
    expect(rowFor(baseline, 'own-child')).toMatchObject({ usageUnavailable: true, tokOut: 0 });

    const unreadable = new TestMemoryStorage();
    unreadable.writeBytes(rootPath, Buffer.alloc(48, 0xff));
    unreadable.writeText(childPath, jsonl(...childEvents('own-child', 'own-root')));
    // A child whose parent never had a rollout here is decided as before.
    unreadable.writeText(orphanPath, jsonl(...childEvents('orphan-child', 'never-recorded-root')));
    const result = await runWithStorage(collectCodexResult, unreadable);
    expect(result.rows.map((row) => row.source?.sourceSessionId)).toEqual(['orphan-child']);
    expect(result.warnings.map((warning) => warning.operation)).toEqual([
      'unreadableHistoryFile',
      'deferredUsageOwnership',
    ]);
    expect(result.warnings[1]).toMatchObject({ harness: 'codex', rejectedRecords: 1 });

    const sessions = await runWithStorage(readCodexUsageSessionsResult, unreadable);
    expect(sessions.ownershipDeferredSessions).toBe(1);
  });

  test('collects the active rollouts with a warning when the archived directory cannot be listed', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-archived-walk-'));
    try {
      const activeDirectory = path.join(home, '.codex', 'sessions', '2026', '09', '01');
      const archivedDirectory = path.join(home, '.codex', 'archived_sessions');
      const movedDirectory = path.join(home, 'archived-elsewhere');
      mkdirSync(activeDirectory, { recursive: true });
      mkdirSync(archivedDirectory, { recursive: true });
      writeFileSync(
        path.join(activeDirectory, 'rollout-2026-09-01T08-00-00-active-thread.jsonl'),
        jsonl(...rolloutEvents('active-thread', 1)),
      );
      const archivedPath = path.join(archivedDirectory, 'rollout-2026-09-01T08-00-00-archived-thread.jsonl.zst');
      writeFileSync(archivedPath, archive(...rolloutEvents('archived-thread', 1)));
      const cachedPaths = () => {
        const db = new Database(path.join(home, '.config', 'ai-usage', 'codex-session-cache.sqlite'));
        try {
          return (
            db.query('SELECT file_path FROM codex_session_cache ORDER BY file_path').all() as { file_path: string }[]
          ).map((row) => row.file_path);
        } finally {
          db.close();
        }
      };

      const listed = await runWithRealStorage(collectCodexResult, home);
      expect(listed.warnings).toEqual([]);
      expect(listed.rows.map((row) => row.source?.sourceSessionId).sort()).toEqual([
        'active-thread',
        'archived-thread',
      ]);
      expect(cachedPaths()).toContain(archivedPath);

      // A symlinked root and a regular file in its place both fail the walk;
      // neither takes the source down.
      renameSync(archivedDirectory, movedDirectory);
      symlinkSync(movedDirectory, archivedDirectory);
      for (const replace of [
        () => undefined,
        () => rmSync(archivedDirectory) ?? writeFileSync(archivedDirectory, ''),
      ]) {
        replace();
        const unlisted = await runWithRealStorage(collectCodexResult, home);
        expect(unlisted.rows.map((row) => row.source?.sourceSessionId)).toEqual(['active-thread']);
        expect(unlisted.warnings).toHaveLength(1);
        expect(unlisted.warnings[0]).toMatchObject({
          harness: 'codex',
          operation: 'unlistedHistoryDirectory',
          path: archivedDirectory,
        });
        expect(unlisted.warnings[0]?.rejectedRecords).toBeUndefined();
        expect(unlisted.observationCompleteness).toEqual({
          exposure: { rejected: 1, truncated: false },
          invocation: { rejected: 1, truncated: false },
        });
        // Unseen is not gone: the archived entry stays cached for the next pass.
        expect(cachedPaths()).toContain(archivedPath);
      }

      const activeDetail = await runWithRealStorage(readCodexDetailForTest('active-thread'), home);
      expect(activeDetail?.turns).toHaveLength(1);
      // An id missing from a partial listing is not "no such session".
      const archivedDetail = await runWithRealStorage(Effect.either(readCodexDetailForTest('archived-thread')), home);
      expect(archivedDetail._tag).toBe('Left');
      if (archivedDetail._tag === 'Left') {
        expect(archivedDetail.left).toMatchObject({ operation: 'readDir', path: archivedDirectory });
      }

      rmSync(archivedDirectory);
      renameSync(movedDirectory, archivedDirectory);
      const restored = await runWithRealStorage(collectCodexResult, home);
      expect(restored.warnings).toEqual([]);
      expect(restored.rows).toEqual(listed.rows);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
