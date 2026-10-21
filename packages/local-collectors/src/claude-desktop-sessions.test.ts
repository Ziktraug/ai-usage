import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';
import {
  type ClaudeDesktopSessionParseContext,
  collectClaudeDesktopSessions,
  parseClaudeDesktopSessionFile,
} from './claude-desktop-sessions';

const PRIVATE_PROMPT_SENTINEL = 'PRIVATE_DESKTOP_PROMPT_SENTINEL_117';
const EPOCH_MS = Date.UTC(2026, 9, 20, 12, 0, 0);
const hoursAgo = (hours: number): number => EPOCH_MS - hours * 3_600_000;
const iso = (epochMs: number) => canonicalInstantFromDate(new Date(epochMs));

const context: ClaudeDesktopSessionParseContext = {
  accountDirectory: 'account-fixture',
  fileModifiedAt: '2026-10-20T12:00:00.000Z',
  machineId: 'machine-fixture',
  observedAt: '2026-10-20T12:05:00.000Z',
  organizationDirectory: 'org-fixture',
  relativeFilePath: '.config/Claude/claude-code-sessions/account-fixture/org-fixture/local_root.json',
};

const noise = {
  alwaysAllowedReasons: [],
  classifierSummaryEnabled: true,
  promptAppendSnapshot: { text: PRIVATE_PROMPT_SENTINEL },
  remoteMcpServersConfig: [],
  sessionPermissionUpdates: [],
  spawnSeed: { seed: 1 },
  toolSurfaceSnapshot: { tools: [PRIVATE_PROMPT_SENTINEL] },
};

const blockedRoot = () => ({
  ...noise,
  backgroundTaskSuggestions: [
    {
      createdAt: hoursAgo(2),
      expiresAt: hoursAgo(-22),
      id: 'task_open1',
      prompt: PRIVATE_PROMPT_SENTINEL,
      title: 'Fixture: follow up on checkout 3',
      tldr: 'A short synopsis of the proposal.',
    },
  ],
  branch: 'fixture/checkout-3',
  cliSessionId: 'cli-root-blocked',
  completedTurns: 7,
  createdAt: hoursAgo(30),
  cwd: '/home/fixture/work/checkout-3',
  effort: 'high',
  interruptedAwaitingPerson: null,
  isArchived: false,
  lastActivityAt: hoursAgo(1),
  lastAssistantUuid: 'assistant-uuid-1',
  lastTurnReport: 'Report of the last turn.',
  model: 'claude-fixture-model',
  originCwd: '/home/fixture/work',
  postTurnSummary: {
    needs_action: 'Confirm whether the fixture should open the pull request.',
    status_category: 'blocked',
    status_detail: 'Waiting for a decision on the pull request.',
    summarizes_uuid: 'assistant-uuid-1',
  },
  postTurnSummaryFor: 'assistant-uuid-1',
  priorCliSessionIds: ['cli-root-blocked-prior'],
  resolvedBackgroundTaskSuggestions: { task_done1: 'started_notified', task_gone1: 'dismissed' },
  sessionId: 'local_root-blocked',
  sideSessionNotes: Array.from({ length: 25 }, (_value, index) => ({
    at: hoursAgo(25 - index),
    batch: 1,
    messageUuid: `note-uuid-${index}`,
    report: `Child report ${index}.`,
    sessionId: `local_child-${index}`,
    title: `Fixture child ${index}`,
  })),
  sourceBranch: 'fixture-main',
  title: 'Fixture: investigate checkout 3',
  titleSource: 'auto',
  turnWrapUp: { description: 'Wrapped up with an open question.' },
  worktreeName: 'checkout-3',
  worktreePath: '/home/fixture/work/checkout-3',
  writtenBranches: ['fixture/checkout-3'],
});

const completedRoot = () => ({
  ...noise,
  cliSessionId: 'cli-root-completed',
  createdAt: hoursAgo(48),
  cwd: '/home/fixture/work/fixture',
  isArchived: true,
  lastActivityAt: hoursAgo(40),
  postTurnSummary: {
    needs_action: '',
    status_category: 'completed',
    status_detail: 'Opened the pull request and pushed the branch.',
    summarizes_uuid: 'assistant-uuid-2',
  },
  prs: [
    {
      autoFix: false,
      baseRef: 'main',
      branch: 'fixture/pr-branch',
      host: 'github.com',
      own: true,
      prNumber: 42,
      provider: 'github',
      repo: 'fixture/ai-usage',
      state: 'OPEN',
      url: 'https://github.com/fixture/ai-usage/pull/42',
    },
  ],
  sessionId: 'local_root-completed',
  title: 'Fixture: ship the branch',
  titleSource: 'tool',
  writtenBranches: ['fixture/pr-branch', 'fixture/pr-branch-2'],
});

const childSession = () => ({
  ...noise,
  cliSessionId: 'cli-child',
  createdAt: hoursAgo(10),
  cwd: '/home/fixture/work/checkout-3',
  isArchived: false,
  lastActivityAt: hoursAgo(9),
  postTurnSummary: {
    needs_action: '',
    status_category: 'review_ready',
    status_detail: 'Ready for review.',
    summarizes_uuid: 'assistant-uuid-3',
  },
  sessionId: 'local_child-1',
  spawnedFrom: {
    name: 'fixture-child',
    sessionId: 'local_root-blocked',
    sideSession: true,
    taskId: 'task_spawn1',
    title: 'Fixture: side investigation',
    wakeParent: false,
  },
  title: 'Enquête',
});

describe('parseClaudeDesktopSessionFile', () => {
  test('normalizes a complete blocked root and never carries a proposal prompt', () => {
    const result = parseClaudeDesktopSessionFile(blockedRoot(), context);
    if (result.kind !== 'observation') {
      throw new Error(`expected an observation, got ${result.kind}`);
    }
    const { observation } = result;
    expect(observation.format).toBe('claude-desktop-session-v1');
    expect(observation.desktopSessionId).toBe('local_root-blocked');
    expect(observation.cliSessionId).toBe('cli-root-blocked');
    expect(observation.machineId).toBe('machine-fixture');
    expect(observation.accountDirectory).toBe('account-fixture');
    expect(observation.organizationDirectory).toBe('org-fixture');
    expect(observation.filePath).toBe(context.relativeFilePath);
    expect(observation.createdAt).toBe(iso(hoursAgo(30)));
    expect(observation.lastActivityAt).toBe(iso(hoursAgo(1)));
    expect(observation.turnSummary).toEqual({
      detail: 'Waiting for a decision on the pull request.',
      needsAction: 'Confirm whether the fixture should open the pull request.',
      status: 'blocked',
      summarizesUuid: 'assistant-uuid-1',
    });
    expect(observation.wrapUpDescription).toBe('Wrapped up with an open question.');
    expect(observation.lastTurnReport).toBe('Report of the last turn.');
    expect(observation.openSuggestions).toEqual([
      {
        createdAt: iso(hoursAgo(2)),
        expiresAt: iso(hoursAgo(-22)),
        id: 'task_open1',
        title: 'Fixture: follow up on checkout 3',
        tldr: 'A short synopsis of the proposal.',
      },
    ]);
    expect(observation.resolvedSuggestions).toEqual({ task_done1: 'started_notified', task_gone1: 'dismissed' });
    expect(observation.priorCliSessionIds).toEqual(['cli-root-blocked-prior']);
    expect(observation.worktreePath).toBe('/home/fixture/work/checkout-3');
    expect(observation.branch).toBe('fixture/checkout-3');
    expect(observation.sourceBranch).toBe('fixture-main');
    expect(observation.completedTurns).toBe(7);
    expect(observation.model).toBe('claude-fixture-model');
    expect(observation.effort).toBe('high');
    expect(observation.titleSource).toBe('auto');
    expect(observation.archived).toBe(false);
    expect(observation.unsupportedReason).toBeNull();
    // The 20 most recent notes survive, in chronological order.
    expect(observation.sideSessionNotes).toHaveLength(WORK_ATTENTION_BOUNDS.maxSideSessionNotes);
    expect(observation.sideSessionNotes[0]?.sessionId).toBe('local_child-5');
    expect(observation.sideSessionNotes.at(-1)?.sessionId).toBe('local_child-24');
    expect(result.clampedFields).toEqual(['sideSessionNotes']);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_PROMPT_SENTINEL);
  });

  test('maps declared pull requests and written branches of a completed root', () => {
    const result = parseClaudeDesktopSessionFile(completedRoot(), context);
    if (result.kind !== 'observation') {
      throw new Error(`expected an observation, got ${result.kind}`);
    }
    expect(result.observation.turnSummary).toEqual({
      detail: 'Opened the pull request and pushed the branch.',
      needsAction: null,
      status: 'completed',
      summarizesUuid: 'assistant-uuid-2',
    });
    expect(result.observation.declaredPullRequests).toEqual([
      {
        baseRef: 'main',
        branch: 'fixture/pr-branch',
        host: 'github.com',
        number: 42,
        own: true,
        repository: 'fixture/ai-usage',
        state: 'OPEN',
        url: 'https://github.com/fixture/ai-usage/pull/42',
      },
    ]);
    expect(result.observation.writtenBranches).toEqual(['fixture/pr-branch', 'fixture/pr-branch-2']);
    expect(result.observation.archived).toBe(true);
    expect(result.observation.titleSource).toBe('tool');
    expect(result.observation.spawnedFrom).toBeNull();
    expect(result.clampedFields).toEqual([]);
  });

  test('keeps the attested spawn origin of a child and labels a missing title source unknown', () => {
    const result = parseClaudeDesktopSessionFile(childSession(), context);
    if (result.kind !== 'observation') {
      throw new Error(`expected an observation, got ${result.kind}`);
    }
    expect(result.observation.spawnedFrom).toEqual({
      sessionId: 'local_root-blocked',
      sideSession: true,
      taskId: 'task_spawn1',
      title: 'Fixture: side investigation',
    });
    expect(result.observation.titleSource).toBe('unknown');
    expect(result.observation.turnSummary?.status).toBe('review_ready');
  });

  test('keeps an identity-only row for an unknown shape and rejects a file without identity', () => {
    const unknownStatus = parseClaudeDesktopSessionFile(
      { ...completedRoot(), postTurnSummary: { status_category: 'waiting_for_person', status_detail: 'x' } },
      context,
    );
    if (unknownStatus.kind !== 'unsupported') {
      throw new Error(`expected unsupported, got ${unknownStatus.kind}`);
    }
    expect(unknownStatus.reason).toContain('postTurnSummary.status_category');
    expect(unknownStatus.observation).toMatchObject({
      cliSessionId: 'cli-root-completed',
      declaredPullRequests: [],
      desktopSessionId: 'local_root-completed',
      format: 'unsupported',
      title: 'Fixture: ship the branch',
      turnSummary: null,
      writtenBranches: [],
    });
    expect(unknownStatus.observation?.unsupportedReason).toBe(unknownStatus.reason);

    const interrupted = parseClaudeDesktopSessionFile(
      { ...blockedRoot(), interruptedAwaitingPerson: { kind: 'unknown' } },
      context,
    );
    expect(interrupted.kind).toBe('unsupported');

    const unknownResolution = parseClaudeDesktopSessionFile(
      { ...blockedRoot(), resolvedBackgroundTaskSuggestions: { task_x: 'snoozed' } },
      context,
    );
    expect(unknownResolution.kind).toBe('unsupported');

    const otherDocument = parseClaudeDesktopSessionFile({ session: { id: 'x' }, v: 2 }, context);
    expect(otherDocument).toEqual({
      kind: 'rejected',
      reason: 'Required fields are missing or invalid: sessionId, cliSessionId, cwd (+4).',
    });
    expect(parseClaudeDesktopSessionFile('not an object', context).kind).toBe('rejected');
    expect(parseClaudeDesktopSessionFile({ ...completedRoot(), createdAt: 'yesterday' }, context)).toEqual({
      kind: 'rejected',
      reason: 'Required fields are missing or invalid: createdAt.',
    });
  });

  test('clamps free text to the Work attention bounds and reports which fields were cut', () => {
    const result = parseClaudeDesktopSessionFile(
      {
        ...blockedRoot(),
        lastTurnReport: 'r'.repeat(1500),
        postTurnSummary: {
          needs_action: 'n'.repeat(600),
          status_category: 'blocked',
          status_detail: 'd'.repeat(600),
        },
        sideSessionNotes: [],
        title: 't'.repeat(300),
        turnWrapUp: { description: 'w'.repeat(1200) },
      },
      context,
    );
    if (result.kind !== 'observation') {
      throw new Error(`expected an observation, got ${result.kind}`);
    }
    expect(result.observation.title).toHaveLength(WORK_ATTENTION_BOUNDS.maxShortText);
    expect(result.observation.turnSummary?.detail).toHaveLength(WORK_ATTENTION_BOUNDS.maxDetailText);
    expect(result.observation.turnSummary?.needsAction).toHaveLength(WORK_ATTENTION_BOUNDS.maxDetailText);
    expect(result.observation.turnSummary?.summarizesUuid).toBeNull();
    expect(result.observation.wrapUpDescription).toHaveLength(WORK_ATTENTION_BOUNDS.maxReportText);
    expect(result.observation.lastTurnReport).toHaveLength(WORK_ATTENTION_BOUNDS.maxReportText);
    expect(result.clampedFields).toEqual([
      'title',
      'lastTurnReport',
      'postTurnSummary.status_detail',
      'postTurnSummary.needs_action',
      'turnWrapUp.description',
    ]);
  });

  test('treats an over-long identifier as an unsupported shape rather than cutting it', () => {
    const result = parseClaudeDesktopSessionFile({ ...completedRoot(), branch: 'b'.repeat(300) }, context);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.reason).toBe('Unsupported field shape: branch.');
    }
  });
});

describe('collectClaudeDesktopSessions', () => {
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
  });

  const seedRegistry = async (): Promise<{ home: string; registry: string }> => {
    const home = await mkdtemp(join(tmpdir(), 'claude-desktop-sessions-'));
    temporaryHomes.push(home);
    const registry = join(home, '.config', 'Claude', 'claude-code-sessions');
    const organization = join(registry, 'account-a', 'org-a');
    await mkdir(join(organization, 'backlog'), { recursive: true });
    await mkdir(join(registry, 'account-b', 'org-b'), { recursive: true });
    const write = (directory: string, name: string, value: unknown) =>
      writeFile(join(directory, name), JSON.stringify(value));
    await write(organization, 'local_root-blocked.json', blockedRoot());
    await write(organization, 'local_child-1.json', childSession());
    await write(join(registry, 'account-b', 'org-b'), 'local_root-completed.json', completedRoot());
    await write(organization, 'local_unknown.json', {
      ...completedRoot(),
      cliSessionId: 'cli-unknown',
      postTurnSummary: { status_category: 'waiting_for_person', status_detail: 'x' },
      sessionId: 'local_unknown',
    });
    await writeFile(join(organization, 'local_broken.json'), '{ not json');
    await write(organization, 'archived-sessions.idx', { archived: ['local_root-completed'], v: 1 });
    await write(organization, 'scheduled-tasks.json', { tasks: [] });
    await write(organization, 'deleted_local_old.json', blockedRoot());
    await write(join(organization, 'backlog'), 'tasks.json', { items: [], version: 1 });
    await write(join(organization, 'backlog'), 'local_nested.json', blockedRoot());
    await write(join(registry, 'account-a'), 'local_stray.json', blockedRoot());
    await symlink(join(organization, 'local_root-blocked.json'), join(organization, 'local_link.json'));
    return { home, registry };
  };

  const collect = (home: string, options: Partial<Parameters<typeof collectClaudeDesktopSessions>[0]> = {}) =>
    Effect.runPromise(
      collectClaudeDesktopSessions({ machineId: 'machine-fixture', now: () => new Date(EPOCH_MS), ...options }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );

  test('reads only regular local_*.json files at account/org depth and counts everything else', async () => {
    const { home } = await seedRegistry();
    const collection = await collect(home);

    expect(collection.completeness).toEqual({
      filesParsed: 3,
      filesSeen: 6,
      rejected: 2,
      truncated: false,
      unsupported: 1,
    });
    expect(collection.observations.map((observation) => observation.desktopSessionId).sort()).toEqual([
      'local_child-1',
      'local_root-blocked',
      'local_root-completed',
      'local_unknown',
    ]);
    const blocked = collection.observations.find(
      (observation) => observation.desktopSessionId === 'local_root-blocked',
    );
    expect(blocked?.filePath).toBe(
      join('.config', 'Claude', 'claude-code-sessions', 'account-a', 'org-a', 'local_root-blocked.json'),
    );
    expect(blocked?.accountDirectory).toBe('account-a');
    expect(blocked?.organizationDirectory).toBe('org-a');
    expect(blocked?.observedAt).toBe(iso(EPOCH_MS));
    expect(Number.isFinite(Date.parse(blocked?.fileModifiedAt ?? ''))).toBe(true);
    const completed = collection.observations.find(
      (observation) => observation.desktopSessionId === 'local_root-completed',
    );
    expect(completed?.accountDirectory).toBe('account-b');
    expect(collection.warnings.map((warning) => [warning.operation, warning.rejectedRecords])).toEqual([
      ['claudeDesktopSessions.notRegularFile', 1],
      ['claudeDesktopSessions.invalidJson', 1],
      ['claudeDesktopSessions.clamped', 1],
    ]);
    expect(JSON.stringify(collection)).not.toContain(PRIVATE_PROMPT_SENTINEL);
  });

  test('stops at the file bound and says so', async () => {
    const { home } = await seedRegistry();
    const collection = await collect(home, { maximumFiles: 2 });

    expect(collection.completeness.filesSeen).toBe(2);
    expect(collection.completeness.truncated).toBe(true);
    expect(collection.warnings.some((warning) => warning.operation === 'claudeDesktopSessions.truncated')).toBe(true);
  });

  test('rejects an oversized file without reading it', async () => {
    const { home } = await seedRegistry();
    const collection = await collect(home, { maximumFileBytes: 1200 });

    expect(collection.completeness.filesParsed).toBeLessThan(3);
    expect(collection.completeness.rejected).toBeGreaterThan(2);
    expect(collection.warnings.some((warning) => warning.operation === 'claudeDesktopSessions.oversized')).toBe(true);
  });

  test('returns an empty, complete collection when the registry does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-desktop-sessions-empty-'));
    temporaryHomes.push(home);
    expect(await collect(home)).toEqual({
      completeness: { filesParsed: 0, filesSeen: 0, rejected: 0, truncated: false, unsupported: 0 },
      observations: [],
      warnings: [],
    });
  });

  test('refuses invalid bounds with a typed error', async () => {
    const { home } = await seedRegistry();
    const failure = await Effect.runPromise(
      collectClaudeDesktopSessions({ machineId: 'machine-fixture', maximumFiles: 0 }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
        Effect.flip,
      ),
    );
    expect(failure._tag).toBe('LocalHistoryError');
    expect(failure.operation).toBe('claudeDesktopSessions.bounds');
  });
});
