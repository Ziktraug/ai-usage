import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BoundedProcessRunner } from '@ai-usage/local-machine/bounded-process';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { WorkThread, WorkThreadWait } from '@ai-usage/report-core/work-thread';
import {
  initializeUsageStore,
  queryWorkFactRunStates,
  queryWorkThreadById,
  queryWorkThreadEvents,
  queryWorkThreadLinks,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import {
  applyWorkThreadCommand,
  importJiraIssueObservations,
  importPullRequestObservations,
  queryLatestJiraIssueObservations,
  queryLatestPullRequestObservations,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createScheduledSourceRegistry } from './source-adapters';
import {
  isolatedSourceOptions,
  isReviewThreadsFixtureRead,
  reviewThreadsFixtureArgs,
  reviewThreadsFixtureResponse,
} from './source-test-fixtures';

const MACHINE = { id: 'wait-machine', label: 'Wait fixture' };
const PR_KEY = 'github.com/fixture/project#7';
const JIRA_KEY = 'jira:default/WAIT-7';
const at = (minute: number) => canonicalInstantFromDate(new Date(Date.UTC(2026, 9, 24, 10, minute)));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Real registry, import and transition paths; every provider command terminates in this fake runner. */
const fixture = async (
  kind: WorkThreadWait['kind'],
  startWaiting = true,
  options: { explicitPullRequest?: boolean } = {},
) => {
  const home = mkdtempSync(path.join(tmpdir(), 'engine-thread-wait-'));
  roots.push(home);
  const dbPath = usageStorePath(home);
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const linkKey = kind === 'pull-request-review' ? PR_KEY : JIRA_KEY;
  const created = await Effect.runPromise(
    applyWorkThreadCommand({
      dbPath,
      machineId: MACHINE.id,
      now: at(0),
      command: {
        op: 'create',
        commandId: randomUUID(),
        title: 'Waiting for external evidence',
        objective: null,
        intent: null,
        projectLabel: null,
        links: [{ kind: kind === 'pull-request-review' ? 'pull-request' : 'jira-issue', key: linkKey }],
      },
    }),
  );
  if (!created.ok) {
    throw new Error('Failed to create thread fixture');
  }
  const threadId = created.threadId;
  const read = async (): Promise<WorkThread> => {
    const value = await Effect.runPromise(queryWorkThreadById({ dbPath, threadId }));
    if (value === null) {
      throw new Error('Missing fixture thread');
    }
    return value;
  };
  const follow = async (to: WorkThread['followState']) => {
    const current = await read();
    const result = await Effect.runPromise(
      applyWorkThreadCommand({
        dbPath,
        machineId: MACHINE.id,
        now: at(5),
        command: {
          op: 'set-follow-state',
          commandId: randomUUID(),
          threadId,
          expectedRevision: current.followRevision,
          to,
          reason: null,
          waitingFor: to === 'waiting' ? 'External decision' : null,
          waitingOn: to === 'waiting' ? { kind, linkKey, since: at(5) } : null,
          acknowledgedRemainders: [],
        },
      }),
    );
    if (!result.ok) {
      throw new Error('Failed fixture state change');
    }
  };
  if (startWaiting) {
    await follow('waiting');
  }
  let now = 6;
  let updatedAt: string = at(0);
  let decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null = 'REVIEW_REQUIRED';
  let mergedAt: string | null = null;
  let jiraStatus = 'To Do';
  let beforeView: (() => void | Promise<void>) | undefined;
  const calls: string[][] = [];
  let openViews = 0;
  let views = 0;
  const runner: BoundedProcessRunner = (request) =>
    Effect.promise(async () => {
      calls.push([request.command, ...request.args]);
      if (request.command === 'gh' && request.args.join(' ') === 'auth token --hostname github.com') {
        return { durationMs: 1, exitCode: 0, stdout: 'fixture-token\n' };
      }
      if (
        (request.command === 'gh' && request.args[0] === 'search') ||
        (request.command === 'acli' && request.args.includes('search'))
      ) {
        return { durationMs: 1, exitCode: 0, stdout: '[]' };
      }
      if (request.command === 'gh' && isReviewThreadsFixtureRead(request.args)) {
        return {
          durationMs: 1,
          exitCode: request.env?.GH_TOKEN === 'fixture-token' ? 0 : 4,
          stdout: request.env?.GH_TOKEN === 'fixture-token' ? reviewThreadsFixtureResponse : '',
        };
      }
      if (request.command === 'gh' && request.args[0] === 'pr' && request.args[1] === 'view') {
        if (request.env?.GH_TOKEN !== 'fixture-token') {
          return { durationMs: 1, exitCode: 4, stdout: '' };
        }
        await beforeView?.();
        views += 1;
        if (mergedAt === null) {
          openViews += 1;
        }
        return {
          durationMs: 1,
          exitCode: 0,
          stdout: JSON.stringify({
            baseRefName: 'main',
            headRefName: 'feature',
            isDraft: false,
            state: mergedAt === null ? 'OPEN' : 'MERGED',
            mergedAt,
            reviewDecision: decision,
            title: 'Agent review and CI messages are not external review decisions',
            updatedAt,
            url: 'https://github.com/fixture/project/pull/7',
            statusCheckRollup: [{ __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'COMPLETED' }],
          }),
        };
      }
      if (request.command === 'acli' && request.args.slice(0, 3).join(' ') === 'jira workitem view') {
        await beforeView?.();
        return {
          durationMs: 1,
          exitCode: 0,
          stdout: JSON.stringify({
            key: 'WAIT-7',
            fields: {
              summary: 'Fixture issue',
              status: { name: jiraStatus, statusCategory: { key: 'indeterminate' } },
              updated: updatedAt,
            },
          }),
        };
      }
      throw new Error(`Unexpected fixture process: ${request.command} ${request.args.join(' ')}`);
    });
  const registry = await Effect.runPromise(
    createScheduledSourceRegistry({
      ...isolatedSourceOptions,
      machine: MACHINE,
      dbPath,
      configCwd: home,
      ghAvailable: () => true,
      acliAvailable: () => true,
      now: () => new Date(at(now)),
      workFactProcessRunner: runner,
      // Only the Done regression needs evidence explicitly linked outside the thread.
      ...(options.explicitPullRequest
        ? {
            workFactInputs: {
              linkedPullRequests: () =>
                Effect.succeed([{ host: 'github.com', repository: 'fixture/project', number: 7 }]),
            },
          }
        : {}),
    }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
  );
  const source = registry.get(kind === 'pull-request-review' ? 'github.pull-requests' : 'jira.issues');
  if (!source) {
    throw new Error('Missing fixture source');
  }
  return {
    dbPath,
    threadId,
    calls,
    read,
    follow,
    poll: async () => {
      const firstCall = calls.length;
      const priorOpenViews = openViews;
      const priorViews = views;
      const result = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
      const graphqlCalls = calls.slice(firstCall).filter((args) => args[0] === 'gh' && args[1] === 'api');
      const newOpenViews = openViews - priorOpenViews;
      // Every view, open or merged, is followed by one bounded detail read (threads and status history).
      const expectedGraphqlCalls = Array.from({ length: views - priorViews }, () => [
        'gh',
        ...reviewThreadsFixtureArgs('fixture/project', 7),
      ]);
      // Check outside the runner: a contained runner defect must not silently weaken these fixtures.
      if (JSON.stringify(graphqlCalls) !== JSON.stringify(expectedGraphqlCalls)) {
        throw new Error('Expected exactly one bounded detail read for each PR view');
      }
      if (newOpenViews > 0) {
        const stored = await Effect.runPromise(queryLatestPullRequestObservations({ dbPath }));
        const latest = stored.items[0]?.latest;
        if (latest?.outcome !== 'observed' || latest.unresolvedReviewThreads !== 2 || latest.outcomeMessage !== null) {
          throw new Error('Expected the complete review-thread fixture to be persisted without a diagnostic');
        }
      }
      return result;
    },
    events: async () =>
      (await Effect.runPromise(queryWorkThreadEvents({ dbPath, threadId }))).filter(
        (event) => event.kind === 'wait-satisfied',
      ),
    next: (input: {
      minute?: number;
      updatedAt?: string;
      decision?: typeof decision;
      mergedAt?: string;
      status?: string;
    }) => {
      now = input.minute ?? now + 1;
      updatedAt = input.updatedAt ?? updatedAt;
      if (input.decision !== undefined) {
        decision = input.decision;
      }
      if (input.mergedAt !== undefined) {
        mergedAt = input.mergedAt;
      }
      jiraStatus = input.status ?? jiraStatus;
    },
    beforeView: (action: () => void | Promise<void>) => {
      beforeView = action;
    },
  };
};

describe('external observations satisfy identified waits through the engine', () => {
  test.each(['APPROVED', 'CHANGES_REQUESTED'] as const)(
    '%s satisfies a PR wait once, with source evidence in the event',
    async (decision) => {
      const input = await fixture('pull-request-review');
      await input.poll();
      expect((await input.read()).followState).toBe('waiting');
      input.next({ minute: 20, updatedAt: at(10), decision });
      await input.poll();
      expect(await input.read()).toMatchObject({
        followState: 'following',
        followRevision: 3,
        waitingFor: null,
        waitingOn: null,
      });
      const events = await input.events();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromState: 'waiting', toState: 'following', linkKey: PR_KEY });
      expect(events[0]?.reason).toContain(decision);
      expect(events[0]?.reason).toContain(at(10));
      input.next({ minute: 21 });
      await input.poll();
      expect(await input.events()).toEqual(events);
      expect((await input.read()).followRevision).toBe(3);
    },
  );

  test('a merge with its own source timestamp satisfies without a prior review baseline', async () => {
    const input = await fixture('pull-request-review');
    input.next({ minute: 20, mergedAt: at(10), updatedAt: at(10), decision: null });
    await input.poll();
    expect((await input.read()).followState).toBe('following');
    expect((await input.events())[0]?.reason).toContain(at(10));
    input.next({ minute: 21 });
    await input.poll();
    expect(await input.events()).toHaveLength(1);
  });

  test.each(['review', 'merge', 'jira-status'] as const)(
    '%s changing during a provider read is bounded by apply time, not fetch-start time',
    async (evidence) => {
      const input = await fixture(evidence === 'jira-status' ? 'jira-update' : 'pull-request-review');
      await input.poll();
      input.next({ minute: 20 });
      input.beforeView(() => {
        input.next({
          minute: 22,
          updatedAt: at(21),
          ...(evidence === 'review' ? { decision: 'APPROVED' as const } : {}),
          ...(evidence === 'merge' ? { mergedAt: at(21) } : {}),
          ...(evidence === 'jira-status' ? { status: 'In Progress' } : {}),
        });
      });
      await input.poll();
      expect(await input.read()).toMatchObject({ followState: 'following', followRevision: 3 });
      const events = await input.events();
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toContain(at(21));
      await input.poll();
      expect(await input.events()).toEqual(events);
    },
  );

  test.each(['review', 'merge'] as const)(
    'recovers a PR %s imported before an interrupted wait transition',
    async (evidence) => {
      const input = await fixture('pull-request-review');
      await input.poll();
      const baseline = (await Effect.runPromise(queryLatestPullRequestObservations({ dbPath: input.dbPath }))).items[0]
        ?.latest;
      if (!baseline) {
        throw new Error('Missing PR baseline');
      }
      await Effect.runPromise(
        importPullRequestObservations({
          dbPath: input.dbPath,
          observations: [
            {
              ...baseline,
              observedAt: at(20),
              updatedAt: at(10),
              state: evidence === 'merge' ? 'MERGED' : 'OPEN',
              mergedAt: evidence === 'merge' ? at(10) : null,
              reviewDecision: evidence === 'review' ? 'APPROVED' : 'REVIEW_REQUIRED',
            },
          ],
        }),
      );
      input.next({
        minute: 21,
        updatedAt: at(10),
        ...(evidence === 'merge' ? { mergedAt: at(10) } : { decision: 'APPROVED' as const }),
      });
      expect(await input.poll()).toMatchObject({ inputCount: 1, outputCount: 1 });
      expect((await input.read()).followState).toBe('following');
      const events = await input.events();
      expect(events).toHaveLength(1);
      input.next({ minute: 22 });
      expect(await input.poll()).toMatchObject({ inputCount: evidence === 'merge' ? 0 : 1 });
      expect(await input.events()).toEqual(events);
    },
  );

  test.each(['old-decision', 'comment-on-approval', 'ci-or-agent-review'] as const)(
    '%s cannot lift a PR wait',
    async (scenario) => {
      const input = await fixture('pull-request-review');
      if (scenario === 'comment-on-approval') {
        input.next({ minute: 6, decision: 'APPROVED' });
      }
      await input.poll();
      input.next({
        minute: 20,
        updatedAt: at(scenario === 'old-decision' ? 4 : 10),
        decision: scenario === 'ci-or-agent-review' ? 'REVIEW_REQUIRED' : 'APPROVED',
      });
      await input.poll();
      expect(await input.read()).toMatchObject({ followState: 'waiting', followRevision: 2 });
      expect(await input.events()).toHaveLength(0);
    },
  );

  test('a review decision without a usable post-wait baseline remains waiting and reports why', async () => {
    const input = await fixture('pull-request-review', false);
    input.next({ minute: 1 });
    await input.poll();
    await input.follow('waiting');
    input.next({ minute: 20, updatedAt: at(10), decision: 'APPROVED' });
    const result = await input.poll();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'pull-request-wait-unproven' }));
    expect((await input.read()).followState).toBe('waiting');
    expect(await input.events()).toHaveLength(0);
  });

  test('an unknown review decision followed by a newer comment cannot establish a new review', async () => {
    const input = await fixture('pull-request-review');
    input.next({ minute: 6, decision: null });
    await input.poll();
    input.next({ minute: 20, updatedAt: at(10), decision: 'APPROVED' });
    const result = await input.poll();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'pull-request-wait-unproven' }));
    expect((await input.read()).followState).toBe('waiting');
    expect(await input.events()).toHaveLength(0);
  });

  test.each(['following', 'done', 'waiting-again'] as const)(
    'operator transition to %s while the provider runs wins',
    async (state) => {
      const input = await fixture('pull-request-review');
      await input.poll();
      input.next({ minute: 20, updatedAt: at(10), decision: 'APPROVED' });
      input.beforeView(async () => {
        await input.follow(state === 'done' ? 'done' : 'following');
        if (state === 'waiting-again') {
          await input.follow('waiting');
        }
      });
      await input.poll();
      expect(await input.read()).toMatchObject({
        followState: state === 'waiting-again' ? 'waiting' : state,
        followRevision: state === 'waiting-again' ? 4 : 3,
      });
      expect(await input.events()).toHaveLength(0);
    },
  );

  test('an already Done thread remains Done when explicit session evidence observes an approval', async () => {
    const input = await fixture('pull-request-review', true, { explicitPullRequest: true });
    await input.poll();
    await input.follow('done');
    input.next({ minute: 20, updatedAt: at(10), decision: 'APPROVED' });
    await input.poll();
    expect(await input.read()).toMatchObject({ followState: 'done', followRevision: 3 });
    expect(await input.events()).toHaveLength(0);
    expect(input.calls.filter((args) => args[0] === 'gh' && args[1] === 'pr')).toHaveLength(2);
  });

  test('detaching and relinking while the provider runs does not satisfy the old link snapshot', async () => {
    const input = await fixture('pull-request-review');
    await input.poll();
    input.next({ minute: 20, updatedAt: at(10), decision: 'APPROVED' });
    input.beforeView(async () => {
      const links = await Effect.runPromise(
        queryWorkThreadLinks({ dbPath: input.dbPath, threadIds: [input.threadId] }),
      );
      const linkId = links[0]?.linkId;
      if (!linkId) {
        throw new Error('Missing fixture link');
      }
      for (const command of [
        { op: 'detach-link' as const, commandId: randomUUID(), threadId: input.threadId, linkId },
        {
          op: 'link' as const,
          commandId: randomUUID(),
          threadId: input.threadId,
          kind: 'pull-request' as const,
          key: PR_KEY,
        },
      ]) {
        const result = await Effect.runPromise(
          applyWorkThreadCommand({ dbPath: input.dbPath, machineId: MACHINE.id, now: at(15), command }),
        );
        expect(result.ok).toBe(true);
      }
    });
    await input.poll();
    expect((await input.read()).followState).toBe('waiting');
    expect(await input.events()).toHaveLength(0);
  });

  test('Jira needs a proven status transition, and the transition is idempotent', async () => {
    const input = await fixture('jira-update');
    await input.poll();
    input.next({ minute: 20, updatedAt: at(10) });
    await input.poll();
    expect((await input.read()).followState).toBe('waiting');
    input.next({ minute: 30, updatedAt: at(25), status: 'In Progress' });
    await input.poll();
    expect(await input.read()).toMatchObject({ followState: 'following', followRevision: 3, waitingOn: null });
    const events = await input.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toContain('In Progress');
    expect(events[0]?.reason).toContain(at(25));
    input.next({ minute: 31 });
    await input.poll();
    expect(await input.events()).toEqual(events);
  });

  test('Jira without stored status proof stays waiting and records the limitation', async () => {
    const input = await fixture('jira-update');
    input.next({ minute: 20, updatedAt: at(10), status: 'In Progress' });
    const result = await input.poll();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'jira-wait-unproven' }));
    expect((await input.read()).followState).toBe('waiting');
    expect(await input.events()).toHaveLength(0);
    const runs = await Effect.runPromise(queryWorkFactRunStates({ dbPath: input.dbPath }));
    expect(runs.runs.find((run) => run.sourceId === 'jira.issues')?.message).toContain('cannot prove a status change');
  });

  test('recovers a Jira status change imported before an interrupted wait transition', async () => {
    const input = await fixture('jira-update');
    await input.poll();
    const baseline = (await Effect.runPromise(queryLatestJiraIssueObservations({ dbPath: input.dbPath }))).items[0]
      ?.latest;
    if (!baseline) {
      throw new Error('Missing Jira baseline');
    }
    await Effect.runPromise(
      importJiraIssueObservations({
        dbPath: input.dbPath,
        observations: [{ ...baseline, observedAt: at(20), updatedAt: at(10), status: 'In Progress' }],
      }),
    );
    input.next({ minute: 21, updatedAt: at(10), status: 'In Progress' });
    await input.poll();
    expect((await input.read()).followState).toBe('following');
    const events = await input.events();
    expect(events).toHaveLength(1);
    input.next({ minute: 22 });
    await input.poll();
    expect(await input.events()).toEqual(events);
  });
});
