import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { setClaudeSkillObservationCeilingForTesting } from '@ai-usage/local-machine/claude-session-facts';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { collectionSourceIds } from '@ai-usage/report-core/source-control';
import { querySkillObservationDataset } from '@ai-usage/report-data/skill-observation-read';
import {
  initializeUsageStore,
  queryLatestProviderQuotaObservations,
  queryNormalizedDatasetItems,
  queryReportRows,
  querySkillObservations,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import { Duration, Effect, Exit } from 'effect';
import { stageCursorUsageExport } from './input-file';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';

const machine = { id: 'machine-a', label: 'Machine A' };

afterEach(() => {
  setClaudeSkillObservationCeilingForTesting(null);
});

const createRegistry = async (home: string, options: Parameters<typeof createScheduledSourceRegistry>[0] = {}) =>
  Effect.runPromise(
    createScheduledSourceRegistry({ machine, ...options }).pipe(
      Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
    ),
  );

const writeClaudeSession = (home: string, inputTokens = 10): void => {
  const directory = path.join(home, '.claude', 'projects', '-work-project');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'session-1.jsonl'),
    `${JSON.stringify({
      cwd: '/work/project',
      message: {
        content: [],
        id: 'message-1',
        model: 'claude-sonnet-4-6',
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: inputTokens,
          output_tokens: 5,
        },
      },
      requestId: 'request-1',
      timestamp: '2026-07-16T10:00:00.000Z',
      type: 'assistant',
    })}\n`,
  );
};

/**
 * A transcript that both produces a usage row and declares a skill invocation,
 * so one source run exercises the row write and the observation write together.
 */
const writeClaudeSkillSession = (home: string, skillNames: readonly string[] = ['improve']): void => {
  const directory = path.join(home, '.claude', 'projects', '-home-alex-Projects-report');
  mkdirSync(directory, { recursive: true });
  const cwd = '/home/alex/Projects/report';
  const events = [
    {
      cwd,
      message: { content: [{ text: 'audit the release', type: 'text' }], role: 'user' },
      sessionId: 'skill-session-1',
      timestamp: '2026-07-16T10:00:00.000Z',
      type: 'user',
      uuid: 'user-1',
    },
    {
      cwd,
      message: {
        content: skillNames.map((skill, index) => ({
          id: index === 0 ? 'toolu_managed' : `toolu_${index}`,
          input: { args: 'Northwind audit', skill },
          name: 'Skill',
          type: 'tool_use',
        })),
        id: 'message-1',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5 },
      },
      parentUuid: 'user-1',
      requestId: 'request-1',
      sessionId: 'skill-session-1',
      timestamp: '2026-07-16T10:00:01.000Z',
      type: 'assistant',
      uuid: 'assistant-1',
    },
    {
      cwd,
      isMeta: true,
      message: {
        content: [{ text: 'Base directory for this skill: /home/alex/.claude/skills/improve', type: 'text' }],
        role: 'user',
      },
      sessionId: 'skill-session-1',
      sourceToolUseID: 'toolu_managed',
      timestamp: '2026-07-16T10:00:02.000Z',
      type: 'user',
      uuid: 'meta-1',
    },
  ];
  writeFileSync(
    path.join(directory, 'skill-session-1.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
};

const progressContext = (progress: unknown[]): SourceRunContext => ({
  reportProgress: (update) =>
    Effect.sync(() => {
      progress.push(update);
    }),
});

describe('scheduled source adapters', () => {
  test('registers the complete catalogue with independent cadence and detection', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-adapters-'));
    try {
      writeClaudeSession(home);
      const registry = await createRegistry(home, { codexLiveAvailable: () => false });

      expect([...registry.keys()]).toEqual([...collectionSourceIds]);
      expect(Duration.toMillis(registry.get('claude.sessions')?.cadence ?? Duration.zero)).toBe(60_000);
      expect(Duration.toMillis(registry.get('codex.usage-limits')?.cadence ?? Duration.zero)).toBe(300_000);
      expect(
        (await Effect.runPromise(registry.get('claude.sessions')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('detected');
      expect(
        (await Effect.runPromise(registry.get('opencode.sessions')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('not-detected');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('never polls Claude for quota on a home that has never run it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-claude-quota-'));
    try {
      // The executable being installed is not consent to open a session. Against a profile with no
      // Claude history, opening one waits on an onboarding prompt, which would stall every isolated
      // environment — test sandboxes included — for the whole collection timeout.
      const withoutHistory = await createRegistry(home, { claudeLiveAvailable: () => true });
      expect(
        (await Effect.runPromise(withoutHistory.get('claude.usage-limits')?.detect ?? Effect.die('missing')))
          .availability,
      ).toBe('not-detected');

      writeClaudeSession(home);
      const withHistory = await createRegistry(home, { claudeLiveAvailable: () => true });
      expect(
        (await Effect.runPromise(withHistory.get('claude.usage-limits')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('detected');

      const withoutBinary = await createRegistry(home, { claudeLiveAvailable: () => false });
      expect(
        (await Effect.runPromise(withoutBinary.get('claude.usage-limits')?.detect ?? Effect.die('missing')))
          .availability,
      ).toBe('not-detected');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('normalizes and imports one session source without global enrichment', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-claude-'));
    try {
      writeClaudeSession(home);
      const registry = await createRegistry(home);
      const source = registry.get('claude.sessions');
      if (!source) {
        throw new Error('Claude source is missing');
      }
      const progress: unknown[] = [];
      const first = await Effect.runPromise(source.run(progressContext(progress)));
      const second = await Effect.runPromise(source.run(progressContext([])));
      const stored = await Effect.runPromise(
        queryReportRows({
          dbPath: usageStorePath(home),
          harnessKeys: ['claude'],
          originMachineIds: [machine.id],
        }),
      );

      expect(first).toMatchObject({ changed: true, inputCount: 1, outputCount: 1, servedProjectionChanged: true });
      expect(second).toMatchObject({ changed: false, inputCount: 1, outputCount: 1, servedProjectionChanged: true });
      expect(progress).toEqual([
        { phase: 'reading' },
        { completed: 1, phase: 'normalizing', total: 1 },
        { completed: 0, phase: 'importing', total: 1 },
      ]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.rtkSavedTokens).toBeUndefined();
      expect(JSON.stringify(first)).not.toContain(home);

      rmSync(path.join(home, '.claude'), { force: true, recursive: true });
      expect(await Effect.runPromise(source.run(progressContext([])))).toMatchObject({
        changed: false,
        unavailable: { code: 'run-unavailable' },
      });
      expect((await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }))).rows).toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('discovers and imports engine-managed Cursor exports without mutating config', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-cursor-import-'));
    try {
      const home = path.join(root, 'home');
      const inboxDirectory = path.join(root, 'state', 'inbox');
      const sourcePath = path.join(root, 'cursor-source.csv');
      const csv = [
        'Date,User,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost',
        '2026-07-30T10:00:00.000Z,user,On-Demand,gpt-5,0,10,0,5,0.01',
      ].join('\n');
      mkdirSync(inboxDirectory, { mode: 0o700, recursive: true });
      writeFileSync(sourcePath, `${csv}\n`, { mode: 0o640 });
      const staged = await stageCursorUsageExport(
        { filePath: sourcePath, kind: 'operator-file' },
        { configCwd: root, inboxDirectory, operatorCwd: root },
      );
      const registry = await createRegistry(home, { configCwd: root });
      const source = registry.get('cursor.sessions');
      if (!source) {
        throw new Error('Cursor source is missing');
      }

      const detection = await Effect.runPromise(source.detect);
      const result = await Effect.runPromise(source.run(progressContext([])));
      const stored = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));

      expect(detection.availability).toBe('detected');
      expect(result).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({ harness: 'Cursor', tokIn: 10, tokOut: 5 });
      expect(await Bun.file(staged.path).exists()).toBe(true);
      expect(await Bun.file(sourcePath).text()).toBe(`${csv}\n`);
      expect(await Bun.file(path.join(root, 'ai-usage.config.ts')).exists()).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('enriches the complete stored local row set without clearing prior facts', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-rtk-'));
    try {
      writeClaudeSession(home);
      const rtkPath = path.join(home, '.local', 'share', 'rtk', 'history.db');
      mkdirSync(path.dirname(rtkPath), { recursive: true });
      const { Database } = await import('bun:sqlite');
      const db = new Database(rtkPath);
      db.exec(`
        CREATE TABLE commands (
          timestamp TEXT,
          project_path TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          saved_tokens INTEGER
        )
      `);
      db.query('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run('2026-07-16T10:00:30.000Z', '/work/project', 4, 2, 9);
      db.close();

      const registry = await createRegistry(home);
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      const result = await Effect.runPromise(
        registry.get('rtk.savings')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const stored = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));

      expect(result).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(stored.rows[0]).toMatchObject({
        rtkCommandCount: 1,
        rtkInputTokens: 4,
        rtkOutputTokens: 2,
        rtkSavedTokens: 9,
      });
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      writeClaudeSession(home, 11);
      await Effect.runPromise(registry.get('claude.sessions')?.run(progressContext([])) ?? Effect.die('missing'));
      const afterBaseReimports = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));
      expect(afterBaseReimports.rows[0]).toMatchObject({ rtkSavedTokens: 9, tokIn: 11 });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists Cursor attribution as versioned normalized items', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-cursor-attribution-'));
    try {
      const attributionPath = path.join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
      mkdirSync(path.dirname(attributionPath), { recursive: true });
      const { Database } = await import('bun:sqlite');
      const db = new Database(attributionPath);
      db.exec(`
        CREATE TABLE scored_commits (
          commitHash TEXT,
          branchName TEXT,
          scoredAt INTEGER,
          linesAdded INTEGER,
          linesDeleted INTEGER,
          tabLinesAdded INTEGER,
          tabLinesDeleted INTEGER,
          composerLinesAdded INTEGER,
          composerLinesDeleted INTEGER,
          humanLinesAdded INTEGER,
          humanLinesDeleted INTEGER,
          blankLinesAdded INTEGER,
          blankLinesDeleted INTEGER,
          commitMessage TEXT,
          commitDate TEXT,
          v1AiPercentage REAL,
          v2AiPercentage REAL
        )
      `);
      db.query('INSERT INTO scored_commits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'abc123',
        'main',
        Date.parse('2026-07-16T10:00:00.000Z'),
        5,
        1,
        0,
        0,
        3,
        1,
        2,
        0,
        0,
        0,
        null,
        null,
        60,
        60,
      );
      db.close();

      const registry = await createRegistry(home);
      const result = await Effect.runPromise(
        registry.get('cursor.commit-attribution')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const stored = await Effect.runPromise(
        queryNormalizedDatasetItems({
          datasetKey: 'cursor.commit-attribution',
          dbPath: usageStorePath(home),
        }),
      );

      expect(result).toMatchObject({ changed: true, inputCount: 1, outputCount: 1 });
      expect(stored.items[0]).toMatchObject({
        machineId: machine.id,
        payload: { branchName: 'main', commitHash: 'abc123' },
        schemaVersion: 1,
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('owns live and backfill quota substeps behind one source', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-source-quota-'));
    try {
      await Effect.runPromise(initializeUsageStore({ dbPath: usageStorePath(home) }));
      const liveSource: ProviderQuotaBatchSource = {
        collect: (request) =>
          Effect.succeed({
            checkpoints: [],
            hasMore: false,
            observations: [
              {
                accountScope: null,
                machineId: request.machineId,
                machineLabel: request.machineLabel ?? null,
                observedAt: (request.observedAt ?? new Date()).toISOString(),
                plan: 'plus',
                providerGeneratedAt: null,
                providerKey: 'codex',
                providerLabel: 'Codex',
                source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
                state: 'ok',
                windows: [],
              },
            ],
            sourceEvents: [],
          }),
      };
      const registry = await createRegistry(home, {
        codexLiveAvailable: () => true,
        now: () => new Date('2026-07-16T10:00:00.000Z'),
        providerQuotaOptions: { backfillSource: null, liveSource },
      });
      const source = registry.get('codex.usage-limits');
      if (!source) {
        throw new Error('Quota source is missing');
      }

      expect((await Effect.runPromise(source.detect)).availability).toBe('detected');
      expect(await Effect.runPromise(source.run(progressContext([])))).toMatchObject({
        changed: true,
        inputCount: 1,
        outputCount: 1,
      });
      const latest = await Effect.runPromise(
        queryLatestProviderQuotaObservations({
          dbPath: usageStorePath(home),
          machineId: machine.id,
          providerKey: 'codex',
        }),
      );
      expect(latest.observations).toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists skill observations collected alongside the session rows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan111-engine-source-skill-observations-'));
    try {
      writeClaudeSkillSession(home);
      const registry = await createRegistry(home);
      const source = registry.get('claude.sessions');

      const result = await Effect.runPromise(source?.run(progressContext([])) ?? Effect.die('missing source'));
      const stored = await Effect.runPromise(querySkillObservations({ dbPath: usageStorePath(home) }));

      expect(result).toMatchObject({ changed: true });
      expect(stored.skipped).toBe(0);
      expect(stored.observations).toHaveLength(1);
      expect(stored.observations[0]?.machineId).toBe(machine.id);
      expect(stored.observations[0]?.observation).toMatchObject({
        harnessKey: 'claude',
        resolvedPath: '/home/alex/.claude/skills/improve',
        skillName: 'improve',
        tier: 'declared',
      });
      // The argument text must not survive the trip to the store.
      expect(JSON.stringify(stored.observations)).not.toContain('Northwind');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('re-checks cancellation before the auxiliary observation write', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan111-engine-source-skill-abort-'));
    try {
      writeClaudeSkillSession(home);
      const registry = await createRegistry(home);
      const source = registry.get('claude.sessions');
      let abortReads = 0;
      const signal = {
        get aborted() {
          abortReads += 1;
          return abortReads >= 3;
        },
      } as AbortSignal;

      const exit = await Effect.runPromiseExit(
        source?.run({ ...progressContext([]), signal }) ?? Effect.die('missing source'),
      );
      const rows = await Effect.runPromise(queryReportRows({ dbPath: usageStorePath(home) }));
      const observations = await Effect.runPromise(querySkillObservations({ dbPath: usageStorePath(home) }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rows.rows).toHaveLength(1);
      expect(observations.observations).toHaveLength(0);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('a second run of an unchanged source reports no change from its observations', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan111-engine-source-skill-idempotent-'));
    try {
      writeClaudeSkillSession(home);
      const registry = await createRegistry(home);
      const source = registry.get('claude.sessions');
      await Effect.runPromise(source?.run(progressContext([])) ?? Effect.die('missing source'));

      const second = await Effect.runPromise(source?.run(progressContext([])) ?? Effect.die('missing source'));
      const stored = await Effect.runPromise(querySkillObservations({ dbPath: usageStorePath(home) }));

      // Re-importing the same observations must not re-publish the report.
      expect(second).toMatchObject({ changed: false });
      expect(stored.observations).toHaveLength(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists a producer-side invocation bound through the fresh read model', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan111-engine-source-skill-incomplete-'));
    try {
      setClaudeSkillObservationCeilingForTesting(1);
      writeClaudeSkillSession(home, ['improve', 'review']);
      const registry = await createRegistry(home, { now: () => new Date('2026-08-29T10:00:00.000Z') });
      const source = registry.get('claude.sessions');

      await Effect.runPromise(source?.run(progressContext([])) ?? Effect.die('missing source'));
      const dataset = await Effect.runPromise(
        querySkillObservationDataset({
          dbPath: usageStorePath(home),
          maximumBytes: 2 * 1024 * 1024,
          maximumObservations: 20_000,
          maximumSkills: 4096,
        }),
      );

      expect(dataset.skills.map(({ skillName }) => skillName)).toEqual(['improve']);
      expect(dataset.lowerBound).toBe(true);
      expect(dataset.invocationLowerBound).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
