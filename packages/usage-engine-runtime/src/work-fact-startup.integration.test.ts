import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestWideEventSinkLayer, noopWideEventSink } from '@ai-usage/effect-runtime';
import type { BoundedProcessOptions, BoundedProcessRunner } from '@ai-usage/local-machine/bounded-process';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import { queryWorkFactRunStates, usageStorePath } from '@ai-usage/usage-store/testing';
import { Effect, Layer, TestContext } from 'effect';
import { createScheduledSourceRegistry } from './source-adapters';
import { createSourceControl, type SourceControlService } from './source-control';

/**
 * The engine's first collection cycle, end to end: the real scheduler over the real source
 * registry on a disposable store and home. The Desktop registry on disk names a worktree, a
 * checkout and two pull requests; after the startup runs, with no cadence elapsed and no operator
 * command, both Work fact producers must have run against those inputs (fake `git` and `gh`
 * answer the processes) and recorded their run state. Before the catalogue reorder and the
 * Desktop wake, both producers ran before the registry was imported and observed nothing.
 */

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

const MACHINE = { id: 'machine-startup', label: 'Startup machine' } as const;
const NOW = new Date('2026-10-21T21:00:00.000Z');
const SHA = 'a'.repeat(40);
const testEnvLayer = Layer.merge(TestContext.TestContext, makeTestWideEventSinkLayer(noopWideEventSink));

const cleanPorcelain = [
  `# branch.oid ${SHA}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  '',
].join('\n');

const pullRequestView = (repository: string, number: number): string =>
  JSON.stringify({
    baseRefName: 'main',
    headRefName: `feat/pr-${String(number)}`,
    isDraft: false,
    mergedAt: null,
    reviewDecision: 'REVIEW_REQUIRED',
    state: 'OPEN',
    statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'COMPLETED' }],
    title: 'Fixture pull request',
    updatedAt: '2026-10-21T18:30:00Z',
    url: `https://github.com/${repository}/pull/${String(number)}`,
  });

/** Answers `git status`/`git log` and `gh pr view` without spawning anything, and records every call. */
const fakeRunner =
  (calls: BoundedProcessOptions[]): BoundedProcessRunner =>
  (options) => {
    calls.push(options);
    const respond = (stdout: string, exitCode = 0) => Effect.succeed({ durationMs: 1, exitCode, stdout });
    if (options.command === 'git') {
      const subcommand = options.args[options.args.indexOf('-C') + 2];
      return subcommand === 'status' ? respond(cleanPorcelain) : respond('2026-10-20T10:00:00+00:00\n');
    }
    if (options.command === 'gh' && options.args[0] === 'pr' && options.args[1] === 'view') {
      return respond(pullRequestView(options.args[4] ?? '', Number(options.args[2])));
    }
    return respond('', 1);
  };

/** A root in a worktree that declared #66 and its child in the main checkout that declared #67. */
const writeDesktopRegistry = (home: string, checkoutPath: string, worktreePath: string): void => {
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
    repo: 'fixture/project',
    state: 'OPEN',
    url: `https://github.com/fixture/project/pull/${String(number)}`,
  });
  const documents = [
    {
      branch: 'feat/wt-1',
      cliSessionId: 'cli-startup-root',
      createdAt: NOW.getTime() - 2 * hour,
      cwd: checkoutPath,
      isArchived: false,
      lastActivityAt: NOW.getTime() - hour,
      postTurnSummary: {
        needs_action: 'Open the pull request for the collector branch.',
        status_category: 'blocked',
        status_detail: 'Stopped on a question.',
        summarizes_uuid: 'uuid-root',
      },
      prs: [pullRequest(66)],
      sessionId: 'local_startup-root',
      title: 'Fixture: startup root',
      titleSource: 'auto',
      worktreeName: path.basename(worktreePath),
      worktreePath,
    },
    {
      cliSessionId: 'cli-startup-child',
      createdAt: NOW.getTime() - hour,
      cwd: checkoutPath,
      isArchived: false,
      lastActivityAt: NOW.getTime() - hour / 2,
      postTurnSummary: {
        needs_action: '',
        status_category: 'completed',
        status_detail: 'Opened it.',
        summarizes_uuid: 'uuid-child',
      },
      prs: [pullRequest(67)],
      sessionId: 'local_startup-child',
      spawnedFrom: { sessionId: 'local_startup-root', taskId: 'task_1', title: 'spawn' },
      title: 'Fixture: startup child',
      titleSource: 'auto',
    },
  ];
  for (const entry of documents) {
    writeFileSync(path.join(directory, `${entry.sessionId}.json`), JSON.stringify(entry));
  }
};

const sourceView = (snapshot: SourceControlView, sourceId: CollectionSourceId) => {
  const source = snapshot.sources.find(({ id }) => id === sourceId);
  if (!source) {
    throw new Error(`Missing source view: ${sourceId}`);
  }
  return source;
};

/** Polls the control plane in real time (the test clock never advances a cadence). */
const waitForSettled = (
  control: SourceControlService,
  sourceIds: readonly CollectionSourceId[],
): Effect.Effect<SourceControlView> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 6000; attempt++) {
      const snapshot = yield* control.getSnapshot;
      if (
        snapshot.queueDepth === 0 &&
        sourceIds.every((id) => {
          const view = sourceView(snapshot, id);
          return view.lastOutcome !== 'not-run' && view.lifecycle !== 'queued' && view.lifecycle !== 'running';
        })
      ) {
        return snapshot;
      }
      yield* Effect.promise(() => Bun.sleep(5));
    }
    return yield* Effect.die(new Error('The startup runs did not settle in time'));
  });

describe('work fact producers on engine startup', () => {
  test('the first cycle observes the checkouts and pull requests the Desktop registry names, without a cadence or a run-now', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'engine-work-fact-startup-'));
    temporaryHomes.push(home);
    const checkoutPath = path.join(home, 'projects', 'example');
    const worktreePath = path.join(checkoutPath, '.claude', 'worktrees', 'wt-1');
    mkdirSync(worktreePath, { recursive: true });
    writeDesktopRegistry(home, checkoutPath, worktreePath);
    const calls: BoundedProcessOptions[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sources = yield* createScheduledSourceRegistry({
          claudeLiveAvailable: () => false,
          codexLiveAvailable: () => false,
          // No CLI is probed: the executor source stays undetected and spawns nothing.
          executorObservation: { which: () => null },
          ghAvailable: () => true,
          gitAvailable: () => true,
          machine: MACHINE,
          now: () => NOW,
          workFactProcessRunner: fakeRunner(calls),
        }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)));
        const control = yield* createSourceControl({
          initialPublicationOrder: 'externally-published',
          policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
          publication: { publish: Effect.succeed({ changed: false }) },
          sources,
        });
        return yield* waitForSettled(control, ['claude.desktop-sessions', 'checkouts.status', 'github.pull-requests']);
      }),
    );
    const settled = await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));

    // The registry was imported, and both producers ran against what it named.
    expect(sourceView(settled, 'claude.desktop-sessions')).toMatchObject({
      inputCount: 2,
      lastOutcome: 'success',
      outputCount: 2,
    });
    expect(sourceView(settled, 'checkouts.status')).toMatchObject({
      inputCount: 2,
      lastOutcome: 'success',
      outputCount: 2,
    });
    expect(sourceView(settled, 'github.pull-requests')).toMatchObject({
      inputCount: 2,
      lastOutcome: 'success',
      outputCount: 2,
    });
    expect(sourceView(settled, 'executors.capabilities').availability).toBe('not-detected');

    const gitPaths = calls.filter(({ command }) => command === 'git').map(({ args }) => args[args.indexOf('-C') + 1]);
    expect(new Set(gitPaths)).toEqual(new Set([checkoutPath, worktreePath]));
    const pullRequests = calls
      .filter(({ command }) => command === 'gh')
      .map(({ args }) => `${args[4]}#${args[2]}`)
      .sort();
    expect(pullRequests).toEqual(['fixture/project#66', 'fixture/project#67']);

    const { runs } = await Effect.runPromise(queryWorkFactRunStates({ dbPath: usageStorePath(home) }));
    expect(
      runs.map(({ sourceId, observed, failed, machineId }) => [sourceId, observed, failed, machineId]).sort(),
    ).toEqual([
      ['checkouts.status', 2, 0, MACHINE.id],
      ['github.pull-requests', 2, 0, MACHINE.id],
    ]);
  }, 60_000);
});
