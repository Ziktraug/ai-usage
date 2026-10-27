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
import { canonicalInstantFromDate, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
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
  publishServedReportRevision,
  queryJiraIntake,
  queryLatestCheckoutStatusObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
  queryWorkFactRunStates,
  queryWorkThreadsPage,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Duration, Effect, Exit } from 'effect';
import { stageCursorUsageExport } from './input-file';
import { createScheduledSourceRegistry, prepareSkillObservationImport, type SourceRunContext } from './source-adapters';
import {
  isolatedSourceOptions,
  isReviewThreadsFixtureRead,
  reviewThreadsFixtureArgs,
  reviewThreadsFixtureResponse,
} from './source-test-fixtures';

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

  test('polls OpenCode for quota only with the CLI and a local OpenCode store', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-opencode-quota-'));
    try {
      const detect = async (registry: Awaited<ReturnType<typeof createRegistry>>) =>
        (await Effect.runPromise(registry.get('opencode.usage-limits')?.detect ?? Effect.die('missing'))).availability;
      expect(await detect(await createRegistry(home, { opencodeLiveAvailable: () => true }))).toBe('not-detected');

      const store = path.join(home, '.local', 'share', 'opencode');
      mkdirSync(store, { recursive: true });
      writeFileSync(path.join(store, 'opencode.db'), '');
      expect(await detect(await createRegistry(home, { opencodeLiveAvailable: () => true }))).toBe('detected');
      expect(await detect(await createRegistry(home, { opencodeLiveAvailable: () => false }))).toBe('not-detected');
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

/** Answers checkout and bounded pull request reads without spawning anything. */
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
    if (options.command === 'gh' && isReviewThreadsFixtureRead(options.args)) {
      return options.env?.GH_TOKEN ? respond(reviewThreadsFixtureResponse) : respond('', 4);
    }
    if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'view') {
      return options.env?.GH_TOKEN
        ? respond(pullRequestView(options.args[4] ?? '', Number(options.args[2])))
        : respond('', 4);
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
            failed: 0,
            machineId: machine.id,
            message: '1 known path no longer exists.',
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

  test('counts stale checkout paths separately while retaining real read failures', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-stale-checkouts-'));
    try {
      const names = ['live', 'not-repository', 'timeout', 'git-error'];
      const paths = names.map((name) => path.join(home, name));
      for (const candidate of paths) {
        mkdirSync(candidate);
      }
      paths.push(path.join(home, 'missing'));
      const runner: BoundedProcessRunner = (options) => {
        const checkoutPath = options.args[options.args.indexOf('-C') + 1];
        if (checkoutPath?.endsWith('/not-repository')) {
          return Effect.succeed({ durationMs: 1, exitCode: 128, stdout: '' });
        }
        if (checkoutPath?.endsWith('/timeout')) {
          return Effect.fail(new BoundedProcessError({ kind: 'timed-out', message: 'Fixture timeout' }));
        }
        if (checkoutPath?.endsWith('/git-error')) {
          return Effect.succeed({ durationMs: 1, exitCode: 1, stdout: '' });
        }
        return fakeWorkFactRunner([])(options);
      };
      const registry = await createRegistry(home, {
        gitAvailable: () => true,
        workFactInputs: { candidateCheckoutPaths: () => Effect.succeed(paths) },
        workFactProcessRunner: runner,
      });
      const result = await Effect.runPromise(registry.get('checkouts.status')!.run(progressContext([])));
      expect(result.warnings).toEqual([]);
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs[0]).toMatchObject({
        observed: 1,
        failed: 2,
        message: '1 known path no longer exists. 1 known path is not a repository.',
      });
      const { items } = await Effect.runPromise(
        queryLatestCheckoutStatusObservations({ dbPath: usageStorePath(home) }),
      );
      expect(items.map(({ latest }) => latest.outcome).sort()).toEqual([
        'invalid',
        'missing',
        'not-a-repository',
        'observed',
        'timeout',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('existing checkouts precede stale paths under the collection cap and report truncation', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-live-checkout-priority-'));
    try {
      const stale = Array.from({ length: 101 }, (_, index) => path.join(home, `gone-${index}`));
      const live = path.join(home, 'live');
      mkdirSync(live);
      const calls: BoundedProcessOptions[] = [];
      const registry = await createRegistry(home, {
        gitAvailable: () => true,
        workFactInputs: { candidateCheckoutPaths: () => Effect.succeed([...stale, live]) },
        workFactProcessRunner: fakeWorkFactRunner(calls),
      });
      const result = await Effect.runPromise(registry.get('checkouts.status')!.run(progressContext([])));
      expect(result).toMatchObject({ inputCount: 102, outputCount: 100, warnings: [{ code: 'checkouts-truncated' }] });
      expect(calls).toHaveLength(2);
      const { items } = await Effect.runPromise(
        queryLatestCheckoutStatusObservations({ dbPath: usageStorePath(home), limit: 100 }),
      );
      expect(items.find(({ latest }) => latest.checkoutPath === live)?.latest.outcome).toBe('observed');
      const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
      expect(runs[0]).toMatchObject({ observed: 1, failed: 0 });
      expect(runs[0]?.message).toContain('100 of 102');
      expect(runs[0]?.message).toContain('99 known paths no longer exist.');
    } finally {
      rmSync(home, { recursive: true, force: true });
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
      expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
        ['auth', 'token'],
        ['search', 'prs'],
        ['search', 'prs'],
        ['search', 'prs'],
        ['auth', 'token'],
        ['pr', 'view'],
        ['api', 'graphql'],
      ]);
      expect(calls[4]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
      expect(calls[5]?.env?.GH_TOKEN).toBe('fixture-token');
      expect(calls[6]?.env?.GH_TOKEN).toBe('fixture-token');
      expect(calls[6]?.args).toEqual(reviewThreadsFixtureArgs('fixture/project', 66));
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => [latest.host, latest.number, latest.outcome, latest.state])).toEqual([
        ['github.com', 66, 'observed', 'OPEN'],
        ['gitlab.com', 3, 'disabled', null],
      ]);
      expect(stored.items.find(({ latest }) => latest.host === 'github.com')?.latest).toMatchObject({
        unresolvedReviewThreads: 2,
        outcomeMessage: null,
      });
      expect(JSON.stringify({ result, stored, args: calls.map(({ args }) => args) })).not.toContain('fixture-token');
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
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: options.args.includes('--user')
              ? 'PRIVATE_ENGINE_TOKEN_SENTINEL\n'
              : 'ACTIVE_ENGINE_TOKEN_SENTINEL\n',
          });
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
      // Each account's batch receives its own resolved token; no configured token leaks to the active account.
      expect(ghCalls).toEqual([
        ['auth token --user', null],
        ['search prs --author=@me', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['search prs user-review-requested:@me', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['search prs --review-requested=@me', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['auth token --user', null],
        ['pr view 66', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['api graphql -f', 'PRIVATE_ENGINE_TOKEN_SENTINEL'],
        ['auth token --hostname', null],
        ['pr view 7', 'ACTIVE_ENGINE_TOKEN_SENTINEL'],
        ['api graphql -f', 'ACTIVE_ENGINE_TOKEN_SENTINEL'],
      ]);
      const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
      expect(calls.filter(({ args }) => args[0] === 'api').map(({ args }) => args)).toEqual([
        reviewThreadsFixtureArgs('fixture/project', 66),
        reviewThreadsFixtureArgs('other/project', 7),
      ]);
      expect(stored.items.map(({ latest }) => [latest.unresolvedReviewThreads, latest.outcomeMessage])).toEqual([
        [2, null],
        [2, null],
      ]);
      expect(stored.items.map(({ latest }) => [latest.number, latest.accountLabel])).toEqual([
        [66, 'alice'],
        [7, null],
      ]);
      expect(JSON.stringify(stored)).not.toContain('PRIVATE_ENGINE_TOKEN_SENTINEL');
      expect(JSON.stringify(stored)).not.toContain('ACTIVE_ENGINE_TOKEN_SENTINEL');
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
      const { threadId } = await createLinkedThread(home, [
        { kind: 'pull-request', key: 'github.com/fixture/project#66' },
      ]);
      await Effect.runPromise(
        importPullRequestObservations({
          dbPath: usageStorePath(home),
          observations: [
            stored(66, {
              history: { complete: true, items: [] },
              mergedAt: '2026-10-21T19:30:00.000Z',
              state: 'MERGED',
            }),
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
      const links = await Effect.runPromise(
        queryWorkThreadLinks({ dbPath: usageStorePath(home), threadIds: [threadId] }),
      );
      expect(links.find(({ kind }) => kind === 'session')).toMatchObject({
        key: 'session:machine-a/claude/cli-desktop-work-root',
        provenance: 'declared',
      });
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
      // The operator's workflow names "In Progress" as handed off; matching ignores case.
      writeHomeConfig(home, { jira: { handedOffStatuses: ['in progress'] } });
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
        [
          'acli',
          'jira',
          'workitem',
          'view',
          'XLB-2091',
          '--fields',
          'key,summary,status,assignee,updated,parent,comment',
          '--json',
        ],
        [
          'acli',
          'jira',
          'workitem',
          'view',
          'XLB-2092',
          '--fields',
          'key,summary,status,assignee,updated,parent,comment',
          '--json',
        ],
        [
          'acli',
          'jira',
          'workitem',
          'view',
          'XLB-2090',
          '--fields',
          'key,summary,status,assignee,updated,parent,comment',
          '--json',
        ],
      ]);
      expect(calls.every(({ env }) => !Object.keys(env ?? {}).some((name) => SECRET_LIKE_VARIABLE.test(name)))).toBe(
        true,
      );
      const stored = await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: usageStorePath(home) }));
      expect(stored.items.map(({ latest }) => latest.key).sort()).toEqual(['XLB-2090', 'XLB-2091', 'XLB-2092']);
      expect(stored.items.every(({ latest }) => latest.outcome === 'observed' && latest.comments.length === 1)).toBe(
        true,
      );
      expect(stored.items.every(({ latest }) => latest.handedOff === true)).toBe(true);
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

test('served declarations retain session identity through same-cycle attachment and repeated runs', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-declared-served-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    const timestamp = canonicalInstantFromDate(now);
    const rows: SerializedRow[] = ['declaring', 'unrelated', 'foreign'].map((id) => ({
      activeDate: timestamp,
      calls: 1,
      costActual: null,
      costApprox: 0,
      costKnown: true,
      date: timestamp,
      durationMs: 1,
      endDate: timestamp,
      freshTokens: 0,
      harness: 'Codex',
      lineDelta: null,
      linesAdded: null,
      linesDeleted: null,
      model: 'fixture',
      name: id,
      project: 'fixture',
      provider: 'fixture',
      sessionLabel: id,
      source: {
        harnessKey: 'codex',
        machineId: id === 'foreign' ? 'different-machine' : machine.id,
        machineLabel: machine.label,
        rootSourceSessionId: id,
        sourceSessionId: id,
        sourcePath: '/fixture/shared-checkout',
        vcs: {
          branches: [],
          headCommit: null,
          partial: false,
          repository: null,
          pullRequests:
            id === 'unrelated'
              ? []
              : [12, 13].map((number) => ({
                  number,
                  observedAt: timestamp,
                  repository: 'fixture/project',
                  url: `https://github.com/fixture/project/pull/${number}`,
                })),
        },
      },
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
      tokenTotal: 0,
      tools: 0,
      turns: 1,
    }));
    const support: FocusedReportSupport = {
      analytics: {
        averageDurationMs: null,
        byHarness: [],
        byModel: [],
        byProvider: [],
        costPer100Lines: null,
        durationMs: 0,
        durationRows: 0,
        lineCount: 0,
        linesA: 0,
        linesD: 0,
        meanCost: 0,
        medianCost: 0,
        pricedCount: 0,
        recentSessions: 0,
        sessionCount: rows.length,
        tools: 0,
        totalCost: 0,
        turns: 0,
        unpricedCount: 0,
      },
      filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      generatedAt: timestamp,
      machineFreshness: {
        kind: 'available',
        machines: [{ id: machine.id, label: machine.label, lastSeenAt: timestamp }],
        observedAt: timestamp,
        omittedMachines: 0,
        skippedRows: 0,
      },
      omittedRows: 0,
      timeZone: 'UTC',
    };
    const dbPath = usageStorePath(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      publishServedReportRevision({
        dbPath,
        now: now.getTime(),
        ttlMs: 300_000,
        revision: 'declared-sessions',
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: timestamp,
          projectAliases: [],
          projectGroupConfigs: [],
          rows,
          sourceAuthorities: rows.map(() => 'local-observed' as const),
          support,
        }),
      }),
    );
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => now,
      workFactProcessRunner: (options) =>
        options.args[0] === 'search'
          ? Effect.succeed({
              durationMs: 1,
              exitCode: 0,
              stdout: JSON.stringify([12, 13].map((number) => discoveredPullRequest(number))),
            })
          : fakeWorkFactRunner([])(options),
    });
    const source = registry.get('github.pull-requests')!;
    for (let repeat = 0; repeat < 2; repeat++) {
      await Effect.runPromise(source.run(progressContext([])));
      const page = await Effect.runPromise(
        queryWorkThreadsPage({ dbPath, query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' } }),
      );
      expect(page.rows).toHaveLength(2);
      const links = await Effect.runPromise(
        queryWorkThreadLinks({ dbPath, threadIds: page.rows.map(({ thread }) => thread.threadId) }),
      );
      const sessions = links.filter(({ kind }) => kind === 'session');
      expect(sessions).toHaveLength(2);
      expect(
        sessions.every(
          ({ key, provenance }) => key === 'session:machine-a/codex/declaring' && provenance === 'declared',
        ),
      ).toBe(true);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Desktop PR declarations join same-cycle discovered threads once and respect detached session links', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-declared-desktop-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    const directory = path.join(home, '.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a');
    mkdirSync(directory, { recursive: true });
    for (const [id, numbers] of [
      ['declaring', [12, 13]],
      ['unrelated', []],
      ['observed-only', [12]],
      ['not-owned', [13]],
      ['unsupported', [12]],
    ] as const) {
      writeFileSync(
        path.join(directory, `local_${id}.json`),
        JSON.stringify({
          cliSessionId: id === 'unsupported' ? '/unsupported' : `cli-${id}`,
          sessionId: `local_${id}`,
          createdAt: now.getTime() - 7_200_000,
          lastActivityAt: now.getTime() - 3_600_000,
          cwd: '/fixture/shared-checkout',
          isArchived: false,
          title: id,
          titleSource: 'auto',
          prs: numbers.map((number) => ({
            autoFix: false,
            baseRef: 'main',
            branch: 'feature',
            host: 'github.com',
            own: id === 'observed-only' ? undefined : id !== 'not-owned',
            prNumber: number,
            provider: 'github',
            repo: 'fixture/project',
            state: 'OPEN',
            url: `https://github.com/fixture/project/pull/${number}`,
          })),
        }),
      );
    }
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => now,
      workFactProcessRunner: (options) =>
        options.args[0] === 'search'
          ? Effect.succeed({
              durationMs: 1,
              exitCode: 0,
              stdout: JSON.stringify([12, 13].map((number) => discoveredPullRequest(number))),
            })
          : fakeWorkFactRunner([])(options),
    });
    await Effect.runPromise(registry.get('claude.desktop-sessions')!.run(progressContext([])));
    const source = registry.get('github.pull-requests')!;
    const readLinks = async () => {
      const page = await Effect.runPromise(
        queryWorkThreadsPage({
          dbPath: usageStorePath(home),
          query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' },
        }),
      );
      expect(page.rows).toHaveLength(2);
      return Effect.runPromise(
        queryWorkThreadLinks({
          dbPath: usageStorePath(home),
          threadIds: page.rows.map(({ thread }) => thread.threadId),
        }),
      );
    };
    for (let run = 0; run < 2; run++) {
      const result = await Effect.runPromise(source.run(progressContext([])));
      expect(result.warnings).toEqual([
        { code: 'declared-sessions-truncated', message: expect.stringContaining('could not be read') },
      ]);
      const links = await readLinks();
      expect(links.filter(({ kind }) => kind === 'session')).toHaveLength(2);
      expect(
        links
          .filter(({ kind }) => kind === 'session')
          .every(
            ({ key, provenance }) => key === 'session:machine-a/claude/cli-declaring' && provenance === 'declared',
          ),
      ).toBe(true);
    }
    const detached = (await readLinks()).find(({ kind }) => kind === 'session');
    if (!detached) {
      throw new Error('Expected declared link');
    }
    await Effect.runPromise(
      applyWorkThreadCommand({
        dbPath: usageStorePath(home),
        machineId: machine.id,
        now: now.toISOString(),
        command: { op: 'detach-link', commandId: randomUUID(), threadId: detached.threadId, linkId: detached.linkId },
      }),
    );
    await Effect.runPromise(source.run(progressContext([])));
    const links = await readLinks();
    expect(links.filter(({ kind, detachedAt }) => kind === 'session' && detachedAt === null)).toHaveLength(1);
    expect(links.find(({ linkId }) => linkId === detached.linkId)?.detachedAt).not.toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
      // Author, personal and team review searches on each of the two runs.
      expect(calls.filter(({ args }) => args[0] === 'search')).toHaveLength(6);
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
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: options.args.includes('--user') ? 'SYNTHETIC_ACCOUNT_TOKEN' : 'SYNTHETIC_ACTIVE_TOKEN',
          });
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
      expect(searches).toHaveLength(3);
      expect(calls.filter(({ args }) => args[0] === 'auth').map(({ args }) => args)).toEqual([
        ['auth', 'token', '--user', 'alice', '--hostname', 'github.com'],
        ['auth', 'token', '--user', 'alice', '--hostname', 'github.com'],
        ['auth', 'token', '--hostname', 'github.com'],
      ]);
      expect(searches[0]?.args).toEqual(expect.arrayContaining(['--owner', 'fixture', 'other']));
      const views = calls.filter(({ args }) => args[0] === 'pr');
      expect(views[0]?.args.slice(0, 5)).toEqual(['pr', 'view', '45', '--repo', 'Fixture/project']);
      expect(views.filter(({ args }) => args[2] === '45')).toHaveLength(1);
      expect(views.find(({ args }) => args[2] === '46')?.env?.GH_TOKEN).toBe('SYNTHETIC_ACTIVE_TOKEN');
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

  test('discovers and observes assigned Jira issues into the intake without creating tasks', async () => {
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
      expect(threads.rows).toEqual([]);
      const intake = await Effect.runPromise(
        queryJiraIntake({ dbPath: usageStorePath(home), limit: 50, machineId: machine.id }),
      );
      expect(intake.items.map(({ key }) => key)).toEqual(['jira:default/DEMO-12']);
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

test('Jira candidates past the ceiling rotate in on the next run, never-read keys first', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-jira-rotation-'));
  try {
    let now = new Date('2026-10-21T21:00:00.000Z');
    writeClaudeDesktopJiraRegistry(home, now);
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      acliAvailable: () => true,
      now: () => now,
      workFactProcessRunner: (options) =>
        options.args[2] === 'search'
          ? Effect.succeed({
              durationMs: 1,
              exitCode: 0,
              stdout: JSON.stringify(Array.from({ length: 25 }, (_, index) => ({ key: `DEMO-${String(index + 1)}` }))),
            })
          : fakeJiraRunner(calls)(options),
    });
    await Effect.runPromise(registry.get('claude.desktop-sessions')?.run(progressContext([])) ?? Effect.die('missing'));
    await Effect.runPromise(registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'));
    const first = calls.splice(0).map(({ args }) => args[3]);
    expect(first).toHaveLength(20);
    now = new Date('2026-10-21T21:10:00.000Z');
    await Effect.runPromise(registry.get('jira.issues')?.run(progressContext([])) ?? Effect.die('missing'));
    const second = calls.map(({ args }) => args[3]);
    const unread = Array.from({ length: 8 }, (_, index) => `DEMO-${String(index + 18)}`);
    // Discovery seeded threads on the first run, so equal read times follow thread-link order.
    expect(new Set(second.slice(0, 8))).toEqual(new Set(unread));
    expect(second.slice(8).every((key) => first.includes(key))).toBe(true);
    expect(new Set([...first, ...second]).size).toBe(28);
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
          history: { complete: true, items: [] },
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

test('re-reads a merged PR stored without its status history once, then leaves it alone', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-pr-history-backfill-'));
  try {
    await createLinkedThread(home, [{ kind: 'pull-request', key: 'github.com/fixture/project#80' }]);
    await Effect.runPromise(
      importPullRequestObservations({
        dbPath: usageStorePath(home),
        observations: [
          {
            accountLabel: null,
            baseRef: 'main',
            checksRollup: 'success' as const,
            draft: false,
            headRef: 'fixture',
            host: 'github.com',
            machineId: machine.id,
            mergedAt: '2026-10-21T20:00:02.000Z',
            number: 80,
            observedAt: '2026-10-21T20:00:03.000Z',
            outcome: 'observed' as const,
            outcomeMessage: null,
            repository: 'Fixture/Project',
            reviewDecision: 'APPROVED',
            state: 'MERGED' as const,
            title: 'Merged before histories were read',
            updatedAt: '2026-10-21T20:00:02.000Z',
            url: 'https://github.com/Fixture/Project/pull/80',
          },
        ],
      }),
    );
    const calls: BoundedProcessOptions[] = [];
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      workFactProcessRunner: (options) => {
        if (options.args[0] === 'search') {
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '[]' });
        }
        if (options.args[0] === 'pr') {
          calls.push(options);
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify({
              ...JSON.parse(pullRequestView(options.args[4] ?? '', Number(options.args[2]))),
              state: 'MERGED',
              mergedAt: '2026-10-21T20:00:02Z',
            }),
          });
        }
        return fakeWorkFactRunner(calls)(options);
      },
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])));
    }
    expect(calls.filter(({ args }) => args[0] === 'pr').map(({ args }) => args[2])).toEqual(['80']);
    const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: usageStorePath(home) }));
    expect(stored.items[0]?.latest.history).toEqual({
      complete: true,
      items: [{ actor: 'reviewer', at: parseCanonicalInstant('2026-10-20T09:00:00.000Z'), kind: 'approved' }],
    });
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

test('declared session attachment bounds remain visible in warnings and persisted run messages', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-declared-session-bound-'));
  try {
    const now = new Date('2026-10-21T21:00:00.000Z');
    writeClaudeDesktopWorkRegistry(home, {
      checkoutPath: path.join(home, 'checkout'),
      worktreePath: path.join(home, 'worktree'),
      oldPath: path.join(home, 'old'),
      now,
    });
    const { threadId } = await createLinkedThread(home, [
      { kind: 'pull-request', key: 'github.com/fixture/project#66' },
      ...Array.from({ length: 63 }, (_, index) => ({
        kind: 'session' as const,
        key: `session:machine-a/codex/existing-${index}`,
      })),
    ]);
    const registry = await createRegistry(home, {
      ghAvailable: () => true,
      now: () => now,
      workFactProcessRunner: fakeWorkFactRunner([]),
    });
    await Effect.runPromise(registry.get('claude.desktop-sessions')!.run(progressContext([])));
    const result = await Effect.runPromise(registry.get('github.pull-requests')!.run(progressContext([])));
    expect(result.warnings).toEqual([
      { code: 'declared-sessions-truncated', message: expect.stringContaining('attachment limits') },
    ]);
    const links = await Effect.runPromise(
      queryWorkThreadLinks({ dbPath: usageStorePath(home), threadIds: [threadId] }),
    );
    expect(links).toHaveLength(64);
    const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
    expect(runs.find(({ sourceId }) => sourceId === 'github.pull-requests')?.message).toContain('attachment limits');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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
