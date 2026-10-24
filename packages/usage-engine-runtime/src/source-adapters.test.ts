import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderQuotaBatchSource } from '@ai-usage/local-collectors';
import { claudeAccountFingerprint } from '@ai-usage/local-collectors/executor-observations';
import {
  BoundedProcessError,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
} from '@ai-usage/local-machine/bounded-process';
import { setClaudeSkillObservationCeilingForTesting } from '@ai-usage/local-machine/claude-session-facts';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { completeSkillObservationCollection, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import { collectionSourceIds } from '@ai-usage/report-core/source-control';
import type { WorkThreadLinkInput } from '@ai-usage/report-core/work-thread';
import { querySkillObservationDataset } from '@ai-usage/report-data/skill-observation-read';
import {
  initializeUsageStore,
  queryClaudeDesktopSessions,
  queryLatestExecutorObservations,
  queryLatestProviderQuotaObservations,
  queryNormalizedDatasetItems,
  queryReportRows,
  querySkillObservations,
  queryWorkThreadLinks,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import {
  applyWorkThreadCommand,
  importPullRequestObservations,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryWorkFactRunStates,
  queryWorkThreadsPage,
} from '@ai-usage/usage-store/writer';
import { Duration, Effect, Exit } from 'effect';
import { stageCursorUsageExport } from './input-file';
import { createScheduledSourceRegistry, prepareSkillObservationImport, type SourceRunContext } from './source-adapters';
import { isolatedSourceOptions } from './source-test-fixtures';

const machine = { id: 'machine-a', label: 'Machine A' };
const SECRET_LIKE_VARIABLE = /TOKEN|SECRET/i;

afterEach(() => {
  setClaudeSkillObservationCeilingForTesting(null);
});

const createRegistry = async (home: string, options: Parameters<typeof createScheduledSourceRegistry>[0] = {}) =>
  Effect.runPromise(
    createScheduledSourceRegistry({ ...isolatedSourceOptions, machine, ...options }).pipe(
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

/** Two Claude Desktop registry files: one complete blocked root, one of an unknown shape. */
const writeClaudeDesktopRegistry = (home: string): void => {
  const directory = path.join(home, '.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a');
  mkdirSync(directory, { recursive: true });
  const base = {
    cliSessionId: 'cli-desktop-root',
    createdAt: Date.UTC(2026, 9, 20, 9),
    cwd: '/home/fixture/work/project',
    isArchived: false,
    lastActivityAt: Date.UTC(2026, 9, 20, 11),
    title: 'Fixture: desktop root',
    titleSource: 'auto',
  };
  writeFileSync(
    path.join(directory, 'local_desktop-root.json'),
    JSON.stringify({
      ...base,
      backgroundTaskSuggestions: [
        {
          createdAt: Date.UTC(2026, 9, 20, 10),
          id: 'task_1',
          prompt: 'PRIVATE_DESKTOP_PROMPT_SENTINEL',
          title: 'Fixture proposal',
          tldr: 'tldr',
        },
      ],
      postTurnSummary: {
        needs_action: 'Decide whether to open the pull request.',
        status_category: 'blocked',
        status_detail: 'Waiting on a decision.',
        summarizes_uuid: 'uuid-1',
      },
      sessionId: 'local_desktop-root',
    }),
  );
  writeFileSync(
    path.join(directory, 'local_desktop-unknown.json'),
    JSON.stringify({
      ...base,
      cliSessionId: 'cli-desktop-unknown',
      lastActivityAt: Date.UTC(2026, 9, 20, 10),
      postTurnSummary: { status_category: 'waiting_for_person', status_detail: 'x' },
      sessionId: 'local_desktop-unknown',
    }),
  );
};

const progressContext = (progress: unknown[]): SourceRunContext => ({
  reportProgress: (update) =>
    Effect.sync(() => {
      progress.push(update);
    }),
});

const skillObservation = (overrides: Partial<SkillObservation> = {}): SkillObservation => ({
  argsPresent: true,
  harnessKey: 'codex',
  observationKey: 'observation-1',
  observedAt: '2026-08-20T10:00:00.000Z',
  projectPath: '/work/project',
  resolvedPath: '/home/alex/.codex/skills/improve',
  sessionId: 'session-1',
  skillName: 'improve',
  success: true,
  tier: 'declared',
  ...overrides,
});

describe('skill observation import preparation', () => {
  test('applies the age cutoff only to exposure before the bounded write batch', () => {
    const prepared = prepareSkillObservationImport({
      completeness: completeSkillObservationCollection(),
      maximumObservations: 3,
      minimumExposureObservedAt: '2026-08-01T00:00:00.000Z',
      observations: [
        skillObservation({ observationKey: 'historical-declared', observedAt: '2025-01-01T00:00:00.000Z' }),
        skillObservation({
          observationKey: 'historical-inferred',
          observedAt: '2025-01-02T00:00:00.000Z',
          tier: 'inferred',
        }),
        skillObservation({
          observationKey: 'expired-exposure',
          observedAt: '2025-01-03T00:00:00.000Z',
          tier: 'exposed',
        }),
        skillObservation({ observationKey: 'current-exposure', tier: 'exposed' }),
      ],
    });

    expect(prepared.observations.map(({ observationKey }) => observationKey)).toEqual([
      'historical-declared',
      'historical-inferred',
      'current-exposure',
    ]);
    expect(prepared.completeness).toEqual(completeSkillObservationCollection());
  });

  test('spends a saturated batch on invocation evidence before exposure', () => {
    const prepared = prepareSkillObservationImport({
      completeness: completeSkillObservationCollection(),
      maximumObservations: 2,
      minimumExposureObservedAt: '2026-08-01T00:00:00.000Z',
      observations: [
        skillObservation({
          observationKey: 'exposed-newest',
          observedAt: '2026-08-29T00:00:00.000Z',
          tier: 'exposed',
        }),
        skillObservation({ observationKey: 'declared', observedAt: '2026-08-20T00:00:00.000Z' }),
        skillObservation({
          observationKey: 'inferred',
          observedAt: '2026-08-21T00:00:00.000Z',
          tier: 'inferred',
        }),
      ],
    });

    expect(prepared.observations.map(({ observationKey }) => observationKey)).toEqual(['inferred', 'declared']);
    expect(prepared.completeness).toEqual({
      exposure: { rejected: 0, truncated: true },
      invocation: { rejected: 0, truncated: false },
    });
  });

  test('reports when invocation evidence itself exceeds the batch', () => {
    const prepared = prepareSkillObservationImport({
      completeness: completeSkillObservationCollection(),
      maximumObservations: 1,
      minimumExposureObservedAt: '2026-08-01T00:00:00.000Z',
      observations: [
        skillObservation({ observationKey: 'declared', observedAt: '2026-08-20T00:00:00.000Z' }),
        skillObservation({
          observationKey: 'inferred-newest',
          observedAt: '2026-08-21T00:00:00.000Z',
          tier: 'inferred',
        }),
      ],
    });

    expect(prepared.observations.map(({ observationKey }) => observationKey)).toEqual(['inferred-newest']);
    expect(prepared.completeness).toEqual({
      exposure: { rejected: 0, truncated: false },
      invocation: { rejected: 0, truncated: true },
    });
  });
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

  test('observes executor capabilities through injected seams and stores them without a publication', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan052-engine-executors-'));
    try {
      const spawned: string[] = [];
      const now = new Date('2026-10-21T21:00:00.000Z');
      const registry = await createRegistry(home, {
        executorObservation: {
          run: (spec) => {
            spawned.push(`${spec.command} ${spec.args.join(' ')}`);
            if (spec.command === 'claude') {
              return Promise.resolve(
                spec.args[0] === '--version'
                  ? { exitCode: 0, stdout: '2.1.303 (Claude Code)\n' }
                  : { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: 'hidden@example.test' }) },
              );
            }
            return Promise.resolve({ exitCode: 1, stdout: '' });
          },
          which: (command) => (command === 'claude' ? '/usr/bin/claude' : null),
        },
        now: () => now,
      });
      const source = registry.get('executors.capabilities');
      expect(Duration.toMillis(source?.cadence ?? Duration.zero)).toBe(900_000);
      expect((await Effect.runPromise(source?.detect ?? Effect.die('missing'))).availability).toBe('detected');
      const progress: unknown[] = [];
      const result = await Effect.runPromise(source?.run(progressContext(progress)) ?? Effect.die('missing'));
      expect(result).toEqual({ changed: false, inputCount: 2, outputCount: 2, warnings: [] });
      // The missing Codex binary is observed, not probed.
      expect(spawned).toEqual(['claude --version', 'claude auth status']);

      const stored = await Effect.runPromise(
        queryLatestExecutorObservations({ dbPath: usageStorePath(home), machineId: machine.id }),
      );
      expect(stored.skipped).toBe(0);
      expect(stored.observations).toEqual([
        {
          // Only the hash of the reported account reaches the store (ADR 0057).
          accountFingerprint: claudeAccountFingerprint({ email: 'hidden@example.test' }) ?? 'missing',
          authEvidence: 'claude auth status exit 0 loggedIn=true',
          authMethod: null,
          authState: 'logged-in',
          binaryPath: '/usr/bin/claude',
          harness: 'claude-code',
          machineId: machine.id,
          observedAt: now.toISOString(),
          outcome: 'observed',
          version: '2.1.303 (Claude Code)',
        },
        {
          authEvidence: 'codex binary not found on PATH',
          authMethod: null,
          authState: 'unknown',
          binaryPath: null,
          harness: 'codex',
          machineId: machine.id,
          observedAt: now.toISOString(),
          outcome: 'unavailable',
          version: null,
        },
      ]);
      expect(JSON.stringify(stored)).not.toContain('hidden@example.test');

      const withoutBinaries = await createRegistry(home, { executorObservation: { which: () => null } });
      expect(
        (await Effect.runPromise(withoutBinaries.get('executors.capabilities')?.detect ?? Effect.die('missing')))
          .availability,
      ).toBe('not-detected');
      const unavailable = await Effect.runPromise(
        withoutBinaries.get('executors.capabilities')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(unavailable.unavailable?.code).toBe('run-unavailable');
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
      let now = new Date('2026-07-16T10:00:00.000Z');
      const registry = await createRegistry(home, { now: () => now });
      const source = registry.get('claude.sessions');
      if (!source) {
        throw new Error('Claude source is missing');
      }
      const progress: unknown[] = [];
      const first = await Effect.runPromise(source.run(progressContext(progress)));
      const second = await Effect.runPromise(source.run(progressContext([])));
      now = new Date('2026-07-16T11:00:00.000Z');
      const third = await Effect.runPromise(source.run(progressContext([])));
      const stored = await Effect.runPromise(
        queryReportRows({
          dbPath: usageStorePath(home),
          harnessKeys: ['claude'],
          originMachineIds: [machine.id],
        }),
      );

      expect(first).toMatchObject({ changed: true, inputCount: 1, outputCount: 1, servedProjectionChanged: true });
      expect(second).toMatchObject({ changed: false, inputCount: 1, outputCount: 1, servedProjectionChanged: false });
      expect(third).toMatchObject({ changed: false, inputCount: 1, outputCount: 1, servedProjectionChanged: true });
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

  test('imports the Claude Desktop registry into its own tables without waking a publication', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'plan117-engine-source-desktop-'));
    try {
      const absent = await createRegistry(home, { codexLiveAvailable: () => false });
      expect(
        (await Effect.runPromise(absent.get('claude.desktop-sessions')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('not-detected');

      writeClaudeDesktopRegistry(home);
      const registry = await createRegistry(home, {
        codexLiveAvailable: () => false,
        now: () => new Date('2026-10-20T12:00:00.000Z'),
      });
      const source = registry.get('claude.desktop-sessions');
      expect(Duration.toMillis(source?.cadence ?? Duration.zero)).toBe(60_000);
      expect((await Effect.runPromise(source?.detect ?? Effect.die('missing'))).availability).toBe('detected');

      const progress: unknown[] = [];
      const first = await Effect.runPromise(source?.run(progressContext(progress)) ?? Effect.die('missing source'));
      const stored = await Effect.runPromise(
        queryClaudeDesktopSessions({ dbPath: usageStorePath(home), machineId: machine.id }),
      );

      // The family is outside the served revision: a full import is not a report change, but new
      // rows wake the two fact producers that read them.
      expect(first).toEqual({
        changed: false,
        inputCount: 2,
        outputCount: 2,
        wake: ['checkouts.status', 'github.pull-requests', 'jira.issues'],
        warnings: [],
      });
      expect(progress.map((update) => (update as { phase: string }).phase)).toEqual([
        'reading',
        'normalizing',
        'importing',
      ]);
      expect(stored.skipped).toBe(0);
      expect(stored.observations.map(({ desktopSessionId, format }) => [desktopSessionId, format])).toEqual([
        ['local_desktop-root', 'claude-desktop-session-v1'],
        ['local_desktop-unknown', 'unsupported'],
      ]);
      expect(stored.observations[0]?.turnSummary?.needsAction).toBe('Decide whether to open the pull request.');
      expect(JSON.stringify(stored)).not.toContain('PRIVATE_DESKTOP_PROMPT_SENTINEL');

      // An unchanged registry wakes nothing.
      const second = await Effect.runPromise(source?.run(progressContext([])) ?? Effect.die('missing source'));
      expect(second).toEqual({ changed: false, inputCount: 2, outputCount: 2, warnings: [] });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

const SHA = 'f'.repeat(40);
const cleanPorcelain = [
  `# branch.oid ${SHA}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  '',
].join('\n');
const pullRequestView = (repository: string, number: number) =>
  JSON.stringify({
    baseRefName: 'main',
    headRefName: 'feat/work-view',
    isDraft: false,
    mergedAt: null,
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'COMPLETED' }],
    title: 'Fixture pull request',
    updatedAt: '2026-10-21T18:30:00Z',
    url: `https://github.com/${repository}/pull/${String(number)}`,
  });

/** A runner that answers git status/log and gh pr view without spawning anything. */
const fakeWorkFactRunner =
  (calls: BoundedProcessOptions[]): BoundedProcessRunner =>
  (options) => {
    calls.push(options);
    const respond = (stdout: string, exitCode = 0) => Effect.succeed({ durationMs: 1, exitCode, stdout });
    if (options.command === 'git') {
      const subcommand = options.args[options.args.indexOf('-C') + 2];
      return subcommand === 'status' ? respond(cleanPorcelain) : respond('2026-10-20T10:00:00+00:00\n');
    }
    if (options.command === 'gh' && options.args[0] === 'auth' && options.args[1] === 'token') {
      return respond('fixture-token\n');
    }
    if (options.command === 'gh' && options.args[0] === 'search') {
      return respond('[]');
    }
    if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'view') {
      return respond(pullRequestView(options.args[4] ?? '', Number(options.args[2])));
    }
    return respond('', 1);
  };

const writeHomeConfig = (home: string, value: unknown): void => {
  const configPath = path.join(home, '.config', 'ai-usage', 'config.json');
  mkdirSync(path.dirname(configPath), { mode: 0o700, recursive: true });
  writeFileSync(configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
};

describe('work fact sources', () => {
  test('registers both fact sources with their cadences and detects them by executable presence', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-detection-'));
    try {
      const registry = await createRegistry(home, { ghAvailable: () => false, gitAvailable: () => true });
      expect(Duration.toMillis(registry.get('checkouts.status')?.cadence ?? Duration.zero)).toBe(300_000);
      expect(Duration.toMillis(registry.get('github.pull-requests')?.cadence ?? Duration.zero)).toBe(600_000);
      expect(await Effect.runPromise(registry.get('checkouts.status')?.detect ?? Effect.die('missing'))).toEqual({
        availability: 'detected',
        reason: { code: 'none' },
      });
      expect(await Effect.runPromise(registry.get('github.pull-requests')?.detect ?? Effect.die('missing'))).toEqual({
        availability: 'not-detected',
        reason: {
          code: 'input-missing',
          message: 'The GitHub CLI (gh) was not found on PATH, so pull requests cannot be observed.',
        },
      });
      const withoutGit = await createRegistry(home, { ghAvailable: () => true, gitAvailable: () => false });
      expect(
        (await Effect.runPromise(withoutGit.get('checkouts.status')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('not-detected');
      expect(
        (await Effect.runPromise(withoutGit.get('github.pull-requests')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('detected');
      writeHomeConfig(home, { github: { enabled: 'yes' } });
      const misconfigured = await createRegistry(home, { ghAvailable: () => true });
      expect(
        (await Effect.runPromise(misconfigured.get('github.pull-requests')?.detect ?? Effect.die('missing')))
          .availability,
      ).toBe('misconfigured');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('observes injected checkout paths through the injected runner and records the run', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-checkouts-'));
    try {
      const checkoutPath = path.join(home, 'projects', 'example');
      mkdirSync(checkoutPath, { recursive: true });
      const calls: BoundedProcessOptions[] = [];
      const now = new Date('2026-10-21T21:00:00.000Z');
      const registry = await createRegistry(home, {
        gitAvailable: () => true,
        now: () => now,
        workFactInputs: {
          candidateCheckoutPaths: () => Effect.succeed([checkoutPath, `${checkoutPath}/`, path.join(home, 'gone')]),
        },
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      const progress: unknown[] = [];
      const result = await Effect.runPromise(
        registry.get('checkouts.status')?.run(progressContext(progress)) ?? Effect.die('missing'),
      );
      expect(result).toEqual({ changed: false, inputCount: 2, outputCount: 2, warnings: [] });
      expect(progress).toEqual([
        { phase: 'discovering' },
        { completed: 0, phase: 'reading', total: 2 },
        { completed: 0, phase: 'importing', total: 2 },
      ]);
      expect(calls.map(({ command }) => command)).toEqual(['git', 'git']);
      const stored = await Effect.runPromise(queryLatestCheckoutStatusObservations({ dbPath: usageStorePath(home) }));
      // Both observations share one instant, so the reader falls back to path order.
      expect(
        stored.items.map(({ latest }) => [latest.checkoutPath, latest.outcome, latest.branch, latest.dirty]),
      ).toEqual([
        [path.join(home, 'gone'), 'missing', null, null],
        [checkoutPath, 'observed', 'main', false],
      ]);
      expect(await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }))).toEqual({
        runs: [
          {
            disabled: false,
            failed: 1,
            machineId: machine.id,
            message: null,
            outcomeCode: null,
            observed: 1,
            ranAt: canonicalInstantFromDate(now),
            sourceId: 'checkouts.status',
          },
        ],
        skipped: 0,
      });
      expect(JSON.stringify(result)).not.toContain(home);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('observes injected pull request links through the injected runner and records the run', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-pull-requests-'));
    try {
      const calls: BoundedProcessOptions[] = [];
      const now = new Date('2026-10-21T21:00:00.000Z');
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        now: () => now,
        workFactInputs: {
          linkedPullRequests: () =>
            Effect.succeed([
              { host: 'github.com', number: 66, repository: 'fixture/project' },
              { host: 'github.com', number: 66, repository: 'fixture/project' },
              { host: 'gitlab.com', number: 3, repository: 'group/project' },
            ]),
        },
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      const result = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toEqual({ changed: false, inputCount: 2, outputCount: 2, warnings: [] });
      expect(
        calls.filter(({ args }) => args[0] === 'pr').map(({ command, args }) => [command, args[0], args[1], args[2]]),
      ).toEqual([['gh', 'pr', 'view', '66']]);
      expect(calls[0]?.env).toMatchObject({ GH_PROMPT_DISABLED: '1' });
      expect(calls[0]?.env?.GH_TOKEN).toBeUndefined();
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => [latest.host, latest.number, latest.outcome, latest.state])).toEqual([
        ['github.com', 66, 'observed', 'OPEN'],
        ['gitlab.com', 3, 'disabled', null],
      ]);
      expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }))).runs).toEqual([
        {
          disabled: false,
          failed: 0,
          machineId: machine.id,
          message: null,
          outcomeCode: null,
          observed: 1,
          ranAt: canonicalInstantFromDate(now),
          sourceId: 'github.pull-requests',
        },
      ]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('records a disabled run without calling gh when github.enabled is false', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-disabled-'));
    try {
      writeHomeConfig(home, { github: { enabled: false } });
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        workFactInputs: {
          linkedPullRequests: () => Effect.succeed([{ host: 'github.com', number: 66, repository: 'fixture/project' }]),
        },
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      const result = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toEqual({
        changed: false,
        inputCount: 0,
        outputCount: 0,
        unavailable: { code: 'policy-disabled', message: 'github.enabled is false in the local config.' },
        warnings: [],
      });
      expect(calls).toHaveLength(0);
      expect((await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }))).runs).toEqual([
        expect.objectContaining({ disabled: true, sourceId: 'github.pull-requests' }),
      ]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('passes a configured account token to gh for that owner only', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-account-'));
    try {
      writeHomeConfig(home, { github: { accounts: [{ ghUser: 'alice', host: 'github.com', owner: 'Fixture' }] } });
      const calls: BoundedProcessOptions[] = [];
      const runner: BoundedProcessRunner = (options) => {
        if (options.command === 'gh' && options.args[0] === 'auth' && options.args[1] === 'token') {
          calls.push(options);
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: 'PRIVATE_ENGINE_TOKEN_SENTINEL\n' });
        }
        return fakeWorkFactRunner(calls)(options);
      };
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        // One instant for both batches: the reader then orders the stored rows by key, not by clock.
        now: () => new Date('2026-10-21T21:00:00.000Z'),
        workFactInputs: {
          linkedPullRequests: () =>
            Effect.succeed([
              { host: 'github.com', number: 66, repository: 'fixture/project' },
              { host: 'github.com', number: 7, repository: 'other/project' },
            ]),
        },
        workFactProcessRunner: runner,
      });
      const result = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toMatchObject({ inputCount: 2, outputCount: 2 });
      const ghCalls = calls.map(({ args, env }) => [args.slice(0, 3).join(' '), env?.GH_TOKEN ?? null]);
      // The configured owner's batch runs first (link order); the active-account batch never sees the token.
      expect(ghCalls).toEqual([
        ['auth token --user', null],
        ['search prs --author=@me', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['search prs --review-requested=@me', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['auth token --user', null],
        ['pr view 66', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['pr view 7', null],
      ]);
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => [latest.number, latest.accountLabel])).toEqual([
        [66, 'alice'],
        [7, null],
      ]);
      expect(JSON.stringify(stored)).not.toContain('PRIVATE_ENGINE_TOKEN_SENTINEL');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('observes the checkouts and pull requests active Desktop sessions declared, ahead of injected ones', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-desktop-'));
    try {
      const now = new Date('2026-10-21T21:00:00.000Z');
      const checkoutPath = path.join(home, 'projects', 'example');
      const worktreePath = path.join(checkoutPath, '.claude', 'worktrees', 'wt-1');
      const oldPath = path.join(home, 'projects', 'old');
      const injectedPath = path.join(home, 'projects', 'injected');
      for (const directory of [worktreePath, oldPath, injectedPath]) {
        mkdirSync(directory, { recursive: true });
      }
      writeClaudeDesktopWorkRegistry(home, { checkoutPath, now, oldPath, worktreePath });
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        gitAvailable: () => true,
        now: () => now,
        workFactInputs: {
          candidateCheckoutPaths: () => Effect.succeed([injectedPath, checkoutPath]),
          linkedPullRequests: () => Effect.succeed([{ host: 'github.com', number: 70, repository: 'fixture/project' }]),
        },
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      // The registry reaches the store through the Desktop source itself, as in the engine.
      const imported = await Effect.runPromise(
        registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(imported).toMatchObject({ inputCount: 3, outputCount: 3 });

      const checkouts = await Effect.runPromise(
        registry.get('checkouts.status')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      // Child (30 min ago) before root (1 h ago), the old session outside the window; the injected
      // duplicate of the child's checkout is one path; `git` runs status and log per checkout.
      expect(checkouts).toEqual({ changed: false, inputCount: 3, outputCount: 3, warnings: [] });
      const gitPaths = calls.filter(({ command }) => command === 'git').map(({ args }) => args[args.indexOf('-C') + 1]);
      expect(gitPaths).toEqual([checkoutPath, checkoutPath, worktreePath, worktreePath, injectedPath, injectedPath]);
      expect(gitPaths).not.toContain(oldPath);

      calls.length = 0;
      const pullRequests = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(pullRequests).toEqual({ changed: false, inputCount: 3, outputCount: 3, warnings: [] });
      expect(
        calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => [args[0], args[1], args[2], args[4]]),
      ).toEqual([
        ['pr', 'view', '67', 'fixture/project'],
        ['pr', 'view', '66', 'fixture/project'],
        ['pr', 'view', '70', 'fixture/project'],
      ]);
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => latest.number).sort((left, right) => left - right)).toEqual([66, 67, 70]);
      expect(JSON.stringify(stored)).not.toContain('#99');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('does not re-observe a mixed-case declared pull request whose latest stored read showed it merged', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-merged-'));
    try {
      const now = new Date('2026-10-21T21:00:00.000Z');
      const checkoutPath = path.join(home, 'projects', 'example');
      const worktreePath = path.join(checkoutPath, '.claude', 'worktrees', 'wt-1');
      mkdirSync(worktreePath, { recursive: true });
      writeClaudeDesktopWorkRegistry(home, {
        checkoutPath,
        now,
        oldPath: path.join(home, 'old'),
        repository: 'Fixture/Project',
        worktreePath,
      });
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        gitAvailable: () => true,
        now: () => now,
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      await Effect.runPromise(
        registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const stored = (number: number, overrides: Record<string, unknown>) => ({
        accountLabel: null,
        baseRef: 'main',
        checksRollup: 'success',
        draft: false,
        headRef: `feat/pr-${String(number)}`,
        host: 'github.com',
        machineId: machine.id,
        mergedAt: null,
        number,
        observedAt: '2026-10-21T20:00:00.000Z',
        outcome: 'observed',
        outcomeMessage: null,
        repository: 'Fixture/Project',
        reviewDecision: null,
        state: 'OPEN',
        title: 'Fixture pull request',
        updatedAt: '2026-10-21T19:00:00.000Z',
        url: `https://github.com/Fixture/Project/pull/${String(number)}`,
        ...overrides,
      });
      // #66 was last seen merged; #67 was seen open and then could not be read: only #67 is live.
      await Effect.runPromise(
        importPullRequestObservations({
          dbPath: usageStorePath(home),
          observations: [
            stored(66, { mergedAt: '2026-10-21T19:30:00.000Z', state: 'MERGED' }),
            stored(67, {}),
            stored(67, {
              baseRef: null,
              checksRollup: null,
              draft: null,
              headRef: null,
              observedAt: '2026-10-21T20:30:00.000Z',
              outcome: 'network',
              outcomeMessage: 'gh exited 1',
              state: null,
              title: null,
              updatedAt: null,
              url: null,
            }),
          ],
        }),
      );

      const pullRequests = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(pullRequests).toEqual({ changed: false, inputCount: 1, outputCount: 1, warnings: [] });
      expect(
        calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => [args[0], args[1], args[2], args[4]]),
      ).toEqual([['pr', 'view', '67', 'Fixture/Project']]);
      const latest = await Effect.runPromise(
        queryLatestPullRequestObservations({ dbPath: usageStorePath(home), machineId: machine.id }),
      );
      expect(
        latest.items.map(({ latest: item }) => [item.number, item.outcome, item.state, item.observedAt]).sort(),
      ).toEqual([
        [66, 'observed', 'MERGED', canonicalInstantFromDate(new Date('2026-10-21T20:00:00.000Z'))],
        [67, 'observed', 'OPEN', canonicalInstantFromDate(now)],
      ]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

/**
 * Three Desktop registry files for the fact sources: a root working in a worktree that declared
 * pull request 66, its child in the main checkout that declared 67, and a session last active
 * twenty days ago that declared 99 in a third checkout, which the fourteen-day window leaves out.
 */
const writeClaudeDesktopWorkRegistry = (
  home: string,
  input: {
    readonly checkoutPath: string;
    readonly now: Date;
    readonly oldPath: string;
    readonly repository?: string;
    readonly worktreePath: string;
  },
): void => {
  const directory = path.join(home, '.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a');
  mkdirSync(directory, { recursive: true });
  const hour = 3_600_000;
  const pullRequest = (number: number) => ({
    autoFix: false,
    baseRef: 'main',
    branch: `feat/pr-${String(number)}`,
    host: 'github.com',
    own: true,
    prNumber: number,
    provider: 'github',
    repo: input.repository ?? 'fixture/project',
    state: 'OPEN',
    url: `https://github.com/${input.repository ?? 'fixture/project'}/pull/${String(number)}`,
  });
  const document = (spec: {
    readonly cwd: string;
    readonly hoursAgo: number;
    readonly id: string;
    readonly pullRequestNumber: number;
    readonly spawnedFrom?: string;
    readonly worktreePath?: string;
  }) => {
    const lastActivityAt = input.now.getTime() - spec.hoursAgo * hour;
    return {
      cliSessionId: `cli-${spec.id}`,
      createdAt: lastActivityAt - hour,
      cwd: spec.cwd,
      isArchived: false,
      lastActivityAt,
      postTurnSummary: {
        needs_action: '',
        status_category: 'completed',
        status_detail: 'Done.',
        summarizes_uuid: `uuid-${spec.id}`,
      },
      prs: [pullRequest(spec.pullRequestNumber)],
      sessionId: `local_${spec.id}`,
      title: `Fixture: ${spec.id}`,
      titleSource: 'auto',
      ...(spec.spawnedFrom === undefined
        ? {}
        : { spawnedFrom: { sessionId: spec.spawnedFrom, taskId: 'task_1', title: 'spawn' } }),
      ...(spec.worktreePath === undefined
        ? {}
        : { branch: 'feat/wt-1', worktreeName: path.basename(spec.worktreePath), worktreePath: spec.worktreePath }),
    };
  };
  const documents = [
    document({
      cwd: input.checkoutPath,
      hoursAgo: 1,
      id: 'desktop-work-root',
      pullRequestNumber: 66,
      worktreePath: input.worktreePath,
    }),
    document({
      cwd: input.checkoutPath,
      hoursAgo: 0.5,
      id: 'desktop-work-child',
      pullRequestNumber: 67,
      spawnedFrom: 'local_desktop-work-root',
    }),
    document({ cwd: input.oldPath, hoursAgo: 20 * 24, id: 'desktop-work-old', pullRequestNumber: 99 }),
  ];
  for (const entry of documents) {
    writeFileSync(path.join(directory, `${entry.sessionId}.json`), JSON.stringify(entry));
  }
};

/** A runner that answers the assumed `acli jira workitem view <KEY> --json` without spawning anything. */
const fakeJiraRunner =
  (calls: BoundedProcessOptions[]): BoundedProcessRunner =>
  (options) => {
    calls.push(options);
    if (options.command === 'acli' && options.args[2] === 'search') {
      return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '[]' });
    }
    if (options.command === 'acli' && options.args.slice(0, 3).join(' ') === 'jira workitem view') {
      return Effect.succeed({
        durationMs: 1,
        exitCode: 0,
        stdout: JSON.stringify({
          fields: {
            comment: {
              comments: [
                { author: { displayName: 'Sam' }, body: 'Reply.', created: '2026-10-21T20:00:00.000Z', id: '1' },
              ],
              total: 1,
            },
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            summary: `Issue ${options.args[3] ?? ''}`,
            updated: '2026-10-21T20:00:00.000Z',
          },
          key: options.args[3],
        }),
      });
    }
    return Effect.succeed({ durationMs: 1, exitCode: 1, stdout: '' });
  };

/**
 * Three Desktop registry files for the Jira source: a root whose declared pull request branch and
 * own branch carry XLB-2090 and whose written branches add XLB-2091 and the XLB-0 placeholder, its
 * more recent child writing XLB-2091 again and XLB-2092, and a session last active twenty days ago
 * on XLB-1999, which the fourteen-day window leaves out. Titles carry a key that must never link.
 */
const writeClaudeDesktopJiraRegistry = (home: string, now: Date): void => {
  const directory = path.join(home, '.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a');
  mkdirSync(directory, { recursive: true });
  const hour = 3_600_000;
  const document = (spec: {
    readonly branch?: string;
    readonly hoursAgo: number;
    readonly id: string;
    readonly pullRequestBranch?: string;
    readonly spawnedFrom?: string;
    readonly writtenBranches?: readonly string[];
  }) => {
    const lastActivityAt = now.getTime() - spec.hoursAgo * hour;
    return {
      cliSessionId: `cli-${spec.id}`,
      createdAt: lastActivityAt - hour,
      cwd: path.join(home, 'projects', 'example'),
      isArchived: false,
      lastActivityAt,
      postTurnSummary: {
        needs_action: '',
        status_category: 'completed',
        status_detail: 'Done.',
        summarizes_uuid: `uuid-${spec.id}`,
      },
      prs:
        spec.pullRequestBranch === undefined
          ? []
          : [
              {
                autoFix: false,
                baseRef: 'main',
                branch: spec.pullRequestBranch,
                host: 'github.com',
                own: true,
                prNumber: 66,
                provider: 'github',
                repo: 'fixture/project',
                state: 'OPEN',
                url: 'https://github.com/fixture/project/pull/66',
              },
            ],
      sessionId: `local_${spec.id}`,
      title: `XLB-7777 ${spec.id}`,
      titleSource: 'auto',
      ...(spec.branch === undefined ? {} : { branch: spec.branch }),
      ...(spec.writtenBranches === undefined ? {} : { writtenBranches: spec.writtenBranches }),
      ...(spec.spawnedFrom === undefined
        ? {}
        : { spawnedFrom: { sessionId: spec.spawnedFrom, taskId: 'task_1', title: 'spawn' } }),
    };
  };
  const documents = [
    document({
      branch: 'feat/XLB-2090/collector',
      hoursAgo: 1,
      id: 'desktop-jira-root',
      pullRequestBranch: 'feat/XLB-2090/collector',
      writtenBranches: ['fix/XLB-2091/nav', 'chore/XLB-0/agent-setup'],
    }),
    document({
      hoursAgo: 0.5,
      id: 'desktop-jira-child',
      spawnedFrom: 'local_desktop-jira-root',
      writtenBranches: ['XLB-2091', 'hotfix/XLB-2092/urgent'],
    }),
    document({ hoursAgo: 20 * 24, id: 'desktop-jira-old', writtenBranches: ['feat/XLB-1999/old'] }),
  ];
  for (const entry of documents) {
    writeFileSync(path.join(directory, `${entry.sessionId}.json`), JSON.stringify(entry));
  }
};

describe('jira issue source', () => {
  test('registers the source at the pull request cadence and detects it by the acli executable', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-detection-'));
    try {
      const absent = await createRegistry(home, { acliAvailable: () => false });
      expect(Duration.toMillis(absent.get('jira.issues')?.cadence ?? Duration.zero)).toBe(600_000);
      expect(await Effect.runPromise(absent.get('jira.issues')?.detect ?? Effect.die('missing'))).toEqual({
        availability: 'not-detected',
        reason: {
          code: 'input-missing',
          message: 'The Atlassian CLI (acli) was not found on PATH, so Jira issues cannot be observed.',
        },
      });
      expect(
        await Effect.runPromise(absent.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing')),
      ).toMatchObject({ unavailable: expect.anything() });
      const present = await createRegistry(home, { acliAvailable: () => true });
      expect((await Effect.runPromise(present.get('jira.issues')?.detect ?? Effect.die('missing'))).availability).toBe(
        'detected',
      );
      writeHomeConfig(home, { jira: { enabled: 'yes' } });
      const misconfigured = await createRegistry(home, { acliAvailable: () => true });
      expect(
        (await Effect.runPromise(misconfigured.get('jira.issues')?.detect ?? Effect.die('missing'))).availability,
      ).toBe('misconfigured');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('observes the keys active Desktop sessions wrote in branch names, never titles, and records the run', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-desktop-'));
    try {
      const now = new Date('2026-10-21T21:00:00.000Z');
      writeClaudeDesktopJiraRegistry(home, now);
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        acliAvailable: () => true,
        now: () => now,
        workFactProcessRunner: fakeJiraRunner(calls),
      });
      expect(
        await Effect.runPromise(
          registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'),
        ),
      ).toMatchObject({ inputCount: 3, outputCount: 3 });
      const result = await Effect.runPromise(
        registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toEqual({ changed: false, inputCount: 3, outputCount: 3, warnings: [] });
      // Child (30 min ago) before root (1 h ago); each key once; the placeholder, the title's key
      // and the twenty-day-old session's key are never read.
      expect(calls.filter(({ args }) => args[2] === 'view').map(({ command, args }) => [command, ...args])).toEqual([
        ['acli', 'jira', 'workitem', 'view', 'XLB-2091', '--json'],
        ['acli', 'jira', 'workitem', 'view', 'XLB-2092', '--json'],
        ['acli', 'jira', 'workitem', 'view', 'XLB-2090', '--json'],
      ]);
      expect(calls.every(({ env }) => !Object.keys(env ?? {}).some((name) => SECRET_LIKE_VARIABLE.test(name)))).toBe(
        true,
      );
      const stored = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => latest.key).sort()).toEqual(['XLB-2090', 'XLB-2091', 'XLB-2092']);
      expect(stored.items.every(({ latest }) => latest.outcome === 'observed' && latest.comments.length === 1)).toBe(
        true,
      );
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain('XLB-1999');
      expect(serialized).not.toContain('XLB-7777');
      expect(serialized).not.toContain('XLB-0"');
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs).toContainEqual({
        disabled: false,
        failed: 0,
        machineId: machine.id,
        message: null,
        outcomeCode: null,
        observed: 3,
        ranAt: canonicalInstantFromDate(now),
        sourceId: 'jira.issues',
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('records a disabled run without calling acli when jira.enabled is false', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-disabled-'));
    try {
      writeHomeConfig(home, { jira: { enabled: false, site: 'example.atlassian.net' } });
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        acliAvailable: () => true,
        workFactProcessRunner: fakeJiraRunner(calls),
      });
      const result = await Effect.runPromise(
        registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toMatchObject({ unavailable: { code: 'policy-disabled' } });
      expect(calls).toEqual([]);
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs).toContainEqual(
        expect.objectContaining({
          disabled: true,
          message: 'jira.enabled is false in the local config.',
          sourceId: 'jira.issues',
        }),
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('an acli that disappeared after detection records the run as disabled with the reason', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-vanished-'));
    try {
      const now = new Date('2026-10-21T21:00:00.000Z');
      writeClaudeDesktopJiraRegistry(home, now);
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        acliAvailable: () => true,
        now: () => now,
        workFactProcessRunner: (options) => {
          calls.push(options);
          return Effect.fail(new BoundedProcessError({ kind: 'unavailable', message: 'Bounded process unavailable' }));
        },
      });
      await Effect.runPromise(
        registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      const result = await Effect.runPromise(
        registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toEqual({
        changed: false,
        inputCount: 0,
        outputCount: 0,
        unavailable: { code: 'input-missing', message: 'acli not installed' },
        warnings: [],
      });
      expect(calls).toHaveLength(1);
      const stored = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items).toEqual([]);
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs).toContainEqual(
        expect.objectContaining({
          disabled: true,
          failed: 0,
          message: 'acli not installed',
          observed: 0,
          sourceId: 'jira.issues',
        }),
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

const discoveredPullRequest = (number: number, repository = 'fixture/project') => ({
  isDraft: false,
  number,
  repository: { nameWithOwner: repository },
  title: `Discovered ${String(number)}`,
  updatedAt: '2026-10-21T18:30:00Z',
  url: `https://github.com/${repository}/pull/${String(number)}`,
});

describe('discovered work fact sources', () => {
  test('discovers author and review requests without sessions, deduplicates, and preserves roles on repeated runs', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-discovered-prs-'));
    try {
      const calls: BoundedProcessOptions[] = [];
      const runner: BoundedProcessRunner = (options) => {
        if (options.args[0] === 'search') {
          calls.push(options);
          const numbers = options.args[2] === '--author=@me' ? [12] : [12, 13];
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify(numbers.map((number) => discoveredPullRequest(number))),
          });
        }
        return fakeWorkFactRunner(calls)(options);
      };
      const registry = await createRegistry(home, { ghAvailable: () => true, workFactProcessRunner: runner });
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(
          await Effect.runPromise(
            registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
          ),
        ).toEqual({ changed: false, inputCount: 2, outputCount: 2, warnings: [] });
      }
      expect(calls.filter(({ args }) => args[0] === 'search')).toHaveLength(4);
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(
        stored.items
          .map(({ latest }) => [latest.number, latest.discoveryRole])
          .sort(([a], [b]) => Number(a) - Number(b)),
      ).toEqual([
        [12, 'author'],
        [13, 'review-requested'],
      ]);
      // Repeated discovery seeds one thread per pull request, with no session behind it.
      const threads = await Effect.runPromise(
        queryWorkThreadsPage({
          dbPath: usageStorePath(home),
          query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' },
        }),
      );
      expect(
        threads.rows
          .map(({ thread }) => [thread.originKey, thread.intent, thread.followState])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ).toEqual([
        ['github.com/fixture/project#12', 'change', 'following'],
        ['github.com/fixture/project#13', 'review', 'following'],
      ]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('explicit links win priority and account while discovery supplies their role before truncation', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-discovery-priority-'));
    try {
      writeHomeConfig(home, {
        github: {
          accounts: [
            { ghUser: 'alice', host: 'github.com', owner: 'fixture' },
            { ghUser: 'alice', host: 'github.com', owner: 'other' },
            { ghUser: 'shadowed', host: 'github.com', owner: 'Fixture' },
          ],
        },
      });
      const calls: BoundedProcessOptions[] = [];
      const runner: BoundedProcessRunner = (options) => {
        if (options.args[0] === 'auth') {
          calls.push(options);
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: 'SYNTHETIC_ACCOUNT_TOKEN' });
        }
        if (options.args[0] === 'search') {
          calls.push(options);
          const rows =
            options.args[2] === '--author=@me'
              ? Array.from({ length: 45 }, (_, index) => discoveredPullRequest(index + 1))
              : [];
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: JSON.stringify(rows) });
        }
        return fakeWorkFactRunner(calls)(options);
      };
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        workFactProcessRunner: runner,
        workFactInputs: {
          linkedPullRequests: () =>
            Effect.succeed([
              { host: 'github.com', number: 45, repository: 'Fixture/project' },
              { host: 'github.com', number: 46, repository: 'unconfigured/project' },
            ]),
        },
      });
      const result = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toMatchObject({
        inputCount: 40,
        outputCount: 40,
        warnings: [{ code: 'pull-requests-truncated', message: expect.stringContaining('46') }],
      });
      const searches = calls.filter(({ args }) => args[0] === 'search');
      expect(searches).toHaveLength(2);
      expect(calls.filter(({ args }) => args[0] === 'auth').every(({ args }) => args[3] === 'alice')).toBe(true);
      expect(searches[0]?.args).toEqual(expect.arrayContaining(['--owner', 'fixture', 'other']));
      const views = calls.filter(({ args }) => args[0] === 'pr');
      expect(views[0]?.args.slice(0, 5)).toEqual(['pr', 'view', '45', '--repo', 'Fixture/project']);
      expect(views.filter(({ args }) => args[2] === '45')).toHaveLength(1);
      expect(views.find(({ args }) => args[2] === '46')?.env?.GH_TOKEN).toBeUndefined();
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.find(({ latest }) => latest.number === 45)?.latest).toMatchObject({
        accountLabel: 'alice',
        discoveryRole: 'author',
        repository: 'Fixture/project',
      });
      expect(stored.items.find(({ latest }) => latest.number === 46)?.latest.discoveryRole).toBeNull();
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists and reports discovery authentication failure even with no linked PRs', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-discovery-auth-'));
    try {
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        ghAvailable: () => true,
        workFactProcessRunner: (options) => {
          calls.push(options);
          return Effect.succeed({ durationMs: 1, exitCode: 4, stdout: '' });
        },
      });
      const result = await Effect.runPromise(
        registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toMatchObject({
        inputCount: 0,
        outputCount: 0,
        warnings: [{ code: 'pull-request-discovery-unauthenticated' }],
      });
      expect(calls.map(({ args }) => args)).toEqual([['auth', 'token', '--hostname', 'github.com']]);
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs).toContainEqual(
        expect.objectContaining({
          failed: 1,
          observed: 0,
          sourceId: 'github.pull-requests',
          outcomeCode: 'unauthenticated',
          message: expect.stringContaining('unauthenticated'),
        }),
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('discovers and observes assigned Jira issues without sessions', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-discovery-jira-'));
    try {
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        acliAvailable: () => true,
        workFactProcessRunner: (options) => {
          if (options.args[2] === 'search') {
            calls.push(options);
            return Effect.succeed({
              durationMs: 1,
              exitCode: 0,
              stdout: JSON.stringify([{ key: 'DEMO-12' }, { key: 'DEMO-12' }]),
            });
          }
          return fakeJiraRunner(calls)(options);
        },
      });
      const result = await Effect.runPromise(
        registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
      );
      expect(result).toEqual({ changed: false, inputCount: 1, outputCount: 1, warnings: [] });
      expect(calls.map(({ args }) => args[2])).toEqual(['search', 'view']);
      const stored = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => [latest.key, latest.outcome])).toEqual([['DEMO-12', 'observed']]);
      const threads = await Effect.runPromise(
        queryWorkThreadsPage({
          dbPath: usageStorePath(home),
          query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' },
        }),
      );
      expect(threads.rows.map(({ thread }) => [thread.origin, thread.originKey])).toEqual([
        ['jira-issue', 'jira:default/DEMO-12'],
      ]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('persists missing acli with zero linked issues both before and after detection', async () => {
    for (const available of [false, true]) {
      const home = mkdtempSync(path.join(tmpdir(), 'engine-discovery-jira-absent-'));
      try {
        const calls: BoundedProcessOptions[] = [];
        const registry = await createRegistry(home, {
          acliAvailable: () => available,
          workFactProcessRunner: (options) => {
            calls.push(options);
            return Effect.fail(
              new BoundedProcessError({ kind: 'unavailable', message: 'Bounded process unavailable' }),
            );
          },
        });
        const result = await Effect.runPromise(
          registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
        );
        expect(result).toMatchObject({ inputCount: 0, outputCount: 0, unavailable: { code: 'input-missing' } });
        expect(calls).toHaveLength(available ? 1 : 0);
        const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
        expect(runs).toContainEqual(
          expect.objectContaining({
            disabled: true,
            observed: 0,
            message: 'acli not installed',
            sourceId: 'jira.issues',
          }),
        );
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    }
  });
});

test('Jira discovery keeps explicit keys first and reports the observation ceiling', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-discovery-ceiling-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    writeClaudeDesktopJiraRegistry(home, now);
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      now: () => now,
      workFactProcessRunner: (options) => {
        if (options.args[2] === 'search') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify([
              { key: 'XLB-2091' },
              ...Array.from({ length: 25 }, (_, index) => ({ key: `DEMO-${String(index + 1)}` })),
            ]),
          });
        }
        return fakeJiraRunner(calls)(options);
      },
    });
    await Effect.runPromise(registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'));
    const result = await Effect.runPromise(
      registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
    );
    expect(result).toMatchObject({
      inputCount: 20,
      outputCount: 20,
      warnings: [{ code: 'jira-issues-truncated', message: expect.stringContaining('28') }],
    });
    const viewedKeys = calls.filter(({ args }) => args[2] === 'view').map(({ args }) => args[3]);
    expect(viewedKeys.slice(0, 4)).toEqual(['XLB-2091', 'XLB-2092', 'XLB-2090', 'DEMO-1']);
    expect(viewedKeys.filter((key) => key === 'XLB-2091')).toHaveLength(1);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test('Jira discovery authentication failure remains visible while explicit issues are observed', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-discovery-failure-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    writeClaudeDesktopJiraRegistry(home, now);
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      now: () => now,
      workFactProcessRunner: (options) =>
        options.args[2] === 'search'
          ? Effect.succeed({ durationMs: 1, exitCode: 1, stdout: JSON.stringify({ status: 401 }) })
          : fakeJiraRunner([])(options),
    });
    await Effect.runPromise(registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'));
    const result = await Effect.runPromise(
      registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'),
    );
    expect(result).toMatchObject({
      inputCount: 3,
      outputCount: 3,
      warnings: [{ code: 'jira-discovery-unauthenticated' }],
    });
    const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
    expect(runs).toContainEqual(
      expect.objectContaining({
        failed: 1,
        observed: 3,
        sourceId: 'jira.issues',
        outcomeCode: 'unauthenticated',
        message: expect.stringContaining('unauthenticated'),
      }),
    );
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test('successive discovery and explicit casing variants preserve source spelling and explicit priority', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-pr-canonical-identity-'));
  try {
    let cycle = 0;
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => new Date(Date.UTC(2026, 9, 21, 21, cycle)),
      workFactInputs: {
        linkedPullRequests: () =>
          Effect.succeed(cycle === 0 ? [] : [{ host: 'github.com', repository: 'fixture/project', number: 12 }]),
      },
      workFactProcessRunner: (options) => {
        if (options.args[0] === 'search') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify(
              options.args[2] === '--author=@me' ? [discoveredPullRequest(12, 'Fixture/Project')] : [],
            ),
          });
        }
        return fakeWorkFactRunner(calls)(options);
      },
    });
    for (cycle = 0; cycle < 2; cycle += 1) {
      expect(
        await Effect.runPromise(
          registry.get('github.pull-requests')?.run(progressContext([])) ?? Effect.die('missing'),
        ),
      ).toEqual({ changed: false, inputCount: 1, outputCount: 1, warnings: [] });
      const repository = cycle === 0 ? 'Fixture/Project' : 'fixture/project';
      const stored = await Effect.runPromise(
        queryLatestPullRequestObservations({
          dbPath: usageStorePath(home),
          links: [{ host: 'github.com', number: 12, repository }],
        }),
      );
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.latest).toMatchObject({
        host: 'github.com',
        repository,
        number: 12,
        discoveryRole: 'author',
        outcome: 'observed',
      });
    }
    expect(calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args[4])).toEqual([
      'Fixture/Project',
      'fixture/project',
    ]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

const createLinkedThread = async (
  home: string,
  links: readonly WorkThreadLinkInput[],
  options: { readonly done?: boolean; readonly machineId?: string; readonly now?: string } = {},
) => {
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const result = await Effect.runPromise(
    applyWorkThreadCommand({
      dbPath,
      machineId: options.machineId ?? machine.id,
      now: options.now ?? '2026-10-21T20:00:00.000Z',
      command: {
        op: 'create',
        commandId: randomUUID(),
        title: 'Operator thread',
        projectLabel: null,
        objective: null,
        intent: null,
        links,
      },
    }),
  );
  if (!result.ok) {
    throw new Error('Thread fixture creation failed');
  }
  if (options.done) {
    const closed = await Effect.runPromise(
      applyWorkThreadCommand({
        dbPath,
        machineId: options.machineId ?? machine.id,
        now: '2026-10-21T20:30:00.000Z',
        command: {
          op: 'set-follow-state',
          commandId: randomUUID(),
          threadId: result.threadId,
          expectedRevision: result.followRevision,
          to: 'done',
          reason: 'Fixture closed',
          acknowledgedRemainders: [],
          waitingFor: null,
          waitingOn: null,
        },
      }),
    );
    if (!closed.ok) {
      throw new Error('Thread fixture closure failed');
    }
  }
  return result;
};

test('an open thread PR remains observable after discovery drops it until a merged fact is stored', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-merged-'));
  try {
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/Fixture/Project#70' }]);
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/fixture/project#71' }], { done: true });
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/fixture/project#72' }], {
      machineId: 'other-machine',
    });
    const calls: BoundedProcessOptions[] = [];
    let cycle = 0;
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => new Date(Date.parse('2026-10-21T21:00:00.000Z') + cycle * 1000),
      workFactProcessRunner: (options) => {
        if (options.args[0] === 'search') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify(cycle === 0 ? [discoveredPullRequest(70)] : []),
          });
        }
        if (options.args[0] === 'pr') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify({
              ...JSON.parse(pullRequestView(options.args[4] ?? '', Number(options.args[2]))),
              state: cycle === 0 ? 'OPEN' : 'MERGED',
              mergedAt: cycle === 0 ? null : '2026-10-21T21:00:01Z',
            }),
          });
        }
        return fakeWorkFactRunner(calls)(options);
      },
    });
    for (cycle = 0; cycle < 3; cycle += 1) {
      const result = await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])));
      expect(result).toMatchObject({
        inputCount: cycle < 2 ? 1 : 0,
        outputCount: cycle < 2 ? 1 : 0,
        warnings: [],
      });
    }
    expect(calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args[2])).toEqual(['70', '70']);
    const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
    expect(stored.items[0]?.latest.state).toBe('MERGED');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('observes an older linked PR when newer merged links fill the candidate bound', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-pr-eligibility-'));
  try {
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/fixture/project#1' }]);
    await createLinkedThread(
      home,
      Array.from({ length: 40 }, (_, index) => ({
        kind: 'pull-request' as const,
        key: `github.com/fixture/project#${index + 2}`,
      })),
      { now: '2026-10-21T20:00:01.000Z' },
    );
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath: usageStorePath(home),
        observations: Array.from({ length: 40 }, (_, index) => ({
          accountLabel: null,
          baseRef: 'main',
          checksRollup: 'success' as const,
          draft: false,
          headRef: 'fixture',
          host: 'github.com',
          machineId: machine.id,
          mergedAt: '2026-10-21T20:00:02.000Z',
          number: index + 2,
          observedAt: '2026-10-21T20:00:03.000Z',
          outcome: 'observed' as const,
          outcomeMessage: null,
          repository: 'Fixture/Project',
          reviewDecision: null,
          state: 'MERGED' as const,
          title: 'Merged fixture',
          updatedAt: '2026-10-21T20:00:02.000Z',
          url: `https://github.com/Fixture/Project/pull/${index + 2}`,
        })),
      }),
    );
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      workFactProcessRunner: (options) =>
        options.args[0] === 'search'
          ? Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '[]' })
          : fakeWorkFactRunner(calls)(options),
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])))).toMatchObject({
        inputCount: 1,
        outputCount: 1,
        warnings: [],
      });
    }
    expect(calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args[2])).toEqual(['1', '1']);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test('observes an older default-site Jira link when other sites fill the candidate bound', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-jira-eligibility-'));
  try {
    await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:default/LINKED-1' }]);
    await createLinkedThread(
      home,
      Array.from({ length: 20 }, (_, index) => ({
        kind: 'jira-issue' as const,
        key: `jira:other-site/OTHER-${index + 1}`,
      })),
      { now: '2026-10-21T20:00:01.000Z' },
    );
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      workFactProcessRunner: (options) =>
        options.args[2] === 'search'
          ? Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '[]' })
          : fakeJiraRunner(calls)(options),
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      expect(await Effect.runPromise(registry.get('jira.issues')!.run(progressContext([])))).toMatchObject({
        inputCount: 1,
        outputCount: 1,
        warnings: [],
      });
    }
    expect(calls.filter(({ args }) => args[2] === 'view').map(({ args }) => args[3])).toEqual(['LINKED-1', 'LINKED-1']);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

const writeCrowdedDesktopRegistry = (home: string, now: Date): void => {
  const directory = path.join(home, '.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a');
  mkdirSync(directory, { recursive: true });
  for (let number = 1; number <= 45; number += 1) {
    const sessionId = `local_crowded-${number}`;
    writeFileSync(
      path.join(directory, `${sessionId}.json`),
      JSON.stringify({
        cliSessionId: `cli-crowded-${number}`,
        createdAt: now.getTime() - 7_200_000,
        cwd: path.join(home, 'projects', 'example'),
        isArchived: false,
        lastActivityAt: now.getTime() - 3_600_000,
        branch: `feat/SESSION-${number}`,
        prs: [
          {
            autoFix: false,
            baseRef: 'main',
            branch: `feat/SESSION-${number}`,
            host: 'github.com',
            own: true,
            prNumber: number,
            provider: 'github',
            repo: 'fixture/project',
            state: 'OPEN',
            url: `https://github.com/fixture/project/pull/${number}`,
          },
        ],
        sessionId,
        title: `Crowded session ${number}`,
        titleSource: 'auto',
      }),
    );
  }
};

test('thread PRs precede 45 session-declared PRs and preserve truncation reporting', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-crowded-prs-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    writeCrowdedDesktopRegistry(home, now);
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/fixture/project#100' }]);
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => now,
      workFactProcessRunner: fakeWorkFactRunner(calls),
    });
    expect(await Effect.runPromise(registry.get('claude.desktop-sessions')!.run(progressContext([])))).toMatchObject({
      inputCount: 45,
      outputCount: 45,
    });
    const result = await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])));
    expect(result).toMatchObject({
      inputCount: 40,
      outputCount: 40,
      warnings: [{ code: 'pull-requests-truncated', message: expect.stringContaining('46') }],
    });
    const viewed = calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => Number(args[2]));
    expect(viewed[0]).toBe(100);
    const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
    expect(stored.items.find(({ latest }) => latest.number === 100)?.latest.outcome).toBe('observed');
    const runs = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
    expect(runs.runs.find(({ sourceId }) => sourceId === 'github.pull-requests')?.message).toContain('40 of 46');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('thread Jira keys precede 45 session-declared keys and preserve truncation reporting', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-crowded-jira-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    writeCrowdedDesktopRegistry(home, now);
    await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:default/LINKED-1' }]);
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      now: () => now,
      workFactProcessRunner: fakeJiraRunner(calls),
    });
    expect(await Effect.runPromise(registry.get('claude.desktop-sessions')!.run(progressContext([])))).toMatchObject({
      inputCount: 45,
      outputCount: 45,
    });
    const result = await Effect.runPromise(registry.get('jira.issues')!.run(progressContext([])));
    expect(result).toMatchObject({
      inputCount: 20,
      outputCount: 20,
      warnings: [{ code: 'jira-issues-truncated', message: expect.stringContaining('46') }],
    });
    const viewed = calls.filter(({ args }) => args[2] === 'view').map(({ args }) => args[3]);
    expect(viewed[0]).toBe('LINKED-1');
    const stored = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: usageStorePath(home) }));
    expect(stored.items.find(({ latest }) => latest.key === 'LINKED-1')?.latest.outcome).toBe('observed');
    const runs = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
    expect(runs.runs.find(({ sourceId }) => sourceId === 'jira.issues')?.message).toContain('20 of 46');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('thread PRs precede injected session links and bounded discovery results', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-pr-priority-'));
  try {
    await createLinkedThread(
      home,
      Array.from({ length: 41 }, (_, i) => ({
        kind: 'pull-request' as const,
        key: `github.com/fixture/project#${String(i + 100)}`,
      })),
    );
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      workFactInputs: {
        linkedPullRequests: () => Effect.succeed([{ host: 'github.com', repository: 'fixture/project', number: 5 }]),
      },
      workFactProcessRunner: (options) => {
        if (options.args[0] === 'search') {
          calls.push(options);
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: JSON.stringify([discoveredPullRequest(1)]) });
        }
        return fakeWorkFactRunner(calls)(options);
      },
    });
    const result = await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])));
    expect(result).toMatchObject({ inputCount: 40, outputCount: 40, warnings: [{ code: 'pull-requests-truncated' }] });
    const viewed = calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => Number(args[2]));
    expect(viewed.every((number) => number >= 100)).toBe(true);
    expect(viewed).not.toContain(5);
    expect(viewed).not.toContain(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('thread Jira keys precede discovery and exclude Done, detached and other-site links', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-jira-priority-'));
  try {
    await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:default/LINKED-1' }]);
    await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:default/CLOSED-1' }], { done: true });
    await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:another-site/OTHER-1' }]);
    const detached = await createLinkedThread(home, [{ kind: 'jira-issue', key: 'jira:default/DETACHED-1' }]);
    const detail = await Effect.runPromise(
      queryWorkThreadLinks({ dbPath: usageStorePath(home), threadIds: [detached.threadId] }),
    );
    const detachedLink = detail[0];
    if (!detachedLink) {
      throw new Error('Missing fixture link');
    }
    const detach = await Effect.runPromise(
      applyWorkThreadCommand({
        dbPath: usageStorePath(home),
        machineId: machine.id,
        now: '2026-10-21T20:30:00.000Z',
        command: {
          op: 'detach-link',
          commandId: randomUUID(),
          threadId: detached.threadId,
          linkId: detachedLink.linkId,
        },
      }),
    );
    expect(detach.ok).toBe(true);
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      workFactProcessRunner: (options) => {
        if (options.args[2] === 'search') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ key: `DEMO-${String(i + 1)}` }))),
          });
        }
        return fakeJiraRunner(calls)(options);
      },
    });
    const result = await Effect.runPromise(registry.get('jira.issues')!.run(progressContext([])));
    expect(result).toMatchObject({ inputCount: 20, outputCount: 20, warnings: [{ code: 'jira-issues-truncated' }] });
    const viewed = calls.filter(({ args }) => args[2] === 'view').map(({ args }) => args[3]);
    expect(viewed[0]).toBe('LINKED-1');
    expect(viewed).not.toContain('CLOSED-1');
    expect(viewed).not.toContain('DETACHED-1');
    expect(viewed).not.toContain('OTHER-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
