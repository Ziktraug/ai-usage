import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { calculateAnalytics } from '@ai-usage/report-core/analytics';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import { queryWorkThreadDetail } from '@ai-usage/report-data/work-thread-read';
import {
  queryReportRows,
  queryWorkThreadById,
  queryWorkThreadEvents,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import {
  applyWorkThreadCommand,
  publishServedReportRevision,
  queryWorkThreadsPage,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createScheduledSourceRegistry } from './source-adapters';
import {
  isolatedSourceOptions,
  isReviewThreadsFixtureRead,
  reviewThreadsFixtureResponse,
} from './source-test-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const machine = { id: 'identity-machine', label: 'Identity fixture' };
const now = new Date('2026-10-24T12:00:00.000Z');
const at = canonicalInstantFromDate(now);
const PR = 'github.com/fixture/project#12';
const SESSION = `session:${machine.id}/claude/session-one`;

const fixture = async (discovery = true) => {
  const home = mkdtempSync(path.join(tmpdir(), 'work-thread-identity-'));
  roots.push(home);
  const dbPath = usageStorePath(home);
  const directory = path.join(home, '.claude/projects/-fixture-project');
  mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, 'session-one.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'assistant', uuid: 'assistant-one', sessionId: 'session-one', timestamp: at, cwd: '/fixture/project', message: { id: 'message-one', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 2 } } })}\n`,
  );
  const registry = await Effect.runPromise(
    createScheduledSourceRegistry({
      ...isolatedSourceOptions,
      machine,
      dbPath,
      configCwd: home,
      now: () => now,
      ghAvailable: () => true,
      workFactProcessRunner: (request) => {
        if (request.args[0] === 'search' && !discovery) {
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: '[]' });
        }
        if (request.args[0] === 'search') {
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify([
              {
                isDraft: false,
                updatedAt: at,
                number: 12,
                title: 'Discovered title',
                repository: { nameWithOwner: 'fixture/project' },
                url: 'https://github.com/fixture/project/pull/12',
              },
            ]),
          });
        }
        if (request.args[0] === 'auth') {
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: 'fixture-token' });
        }
        if (isReviewThreadsFixtureRead(request.args)) {
          return Effect.succeed({ durationMs: 1, exitCode: 0, stdout: reviewThreadsFixtureResponse });
        }
        if (request.args[0] === 'pr') {
          return Effect.succeed({
            durationMs: 1,
            exitCode: 0,
            stdout: JSON.stringify({
              number: 12,
              title: 'Discovered title',
              state: 'OPEN',
              isDraft: false,
              baseRefName: 'main',
              headRefName: 'feature',
              updatedAt: at,
              url: 'https://github.com/fixture/project/pull/12',
              statusCheckRollup: [],
            }),
          });
        }
        return Effect.die(`Unexpected fake command ${request.command} ${request.args.join(' ')}`);
      },
    }).pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))),
  );
  const collect = (id: 'claude.sessions' | 'github.pull-requests') => {
    const source = registry.get(id);
    if (!source) {
      throw new Error('Missing source');
    }
    return Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
  };
  let publication = 0;
  const publish = async () => {
    const { rows: usageRows } = await Effect.runPromise(queryReportRows({ dbPath }));
    const rows = usageRows.map(serializeUsageRow);
    await Effect.runPromise(
      publishServedReportRevision({
        dbPath,
        now: now.getTime(),
        ttlMs: 300_000,
        revision: `identity-${publication++}`,
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: at,
          projectAliases: [],
          projectGroupConfigs: [],
          rows,
          sourceAuthorities: rows.map(() => 'local-observed' as const),
          support: {
            analytics: calculateAnalytics(usageRows),
            filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
            generatedAt: at,
            machineFreshness: {
              kind: 'available',
              machines: [{ id: machine.id, label: machine.label, lastSeenAt: at }],
              observedAt: at,
              omittedMachines: 0,
              skippedRows: 0,
            },
            omittedRows: 0,
            timeZone: 'UTC',
          },
        }),
      }),
    );
  };
  await collect('claude.sessions');
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
  await publish();
  const result = await Effect.runPromise(
    applyWorkThreadCommand({
      dbPath,
      machineId: machine.id,
      now: at,
      command: {
        op: 'create',
        commandId: randomUUID(),
        title: 'My personal title',
        objective: 'Keep this objective',
        intent: 'analysis',
        projectLabel: 'Custom project',
        links: [{ kind: 'session', key: SESSION }],
      },
    }),
  );
  if (!result.ok) {
    throw new Error('Create failed');
  }
  const threadId = result.threadId;
  return {
    dbPath,
    threadId,
    collect,
    publish,
    declare: () =>
      appendFileSync(
        transcript,
        `${JSON.stringify({ type: 'pr-link', sessionId: 'session-one', timestamp: at, prUrl: 'https://github.com/fixture/project/pull/12', prNumber: 12, prRepository: 'fixture/project' })}\n`,
      ),
  };
};

test.each([true, false])(
  'native first PR keeps one identity through collection and readers (discovery=%s)',
  async (discovery) => {
    const f = await fixture(discovery);
    const before = await Effect.runPromise(queryWorkThreadById({ dbPath: f.dbPath, threadId: f.threadId }));
    f.declare();
    await f.collect('claude.sessions');
    await f.publish();
    for (let replay = 0; replay < 2; replay++) {
      await f.collect('github.pull-requests');
      const page = await Effect.runPromise(
        queryWorkThreadsPage({
          dbPath: f.dbPath,
          query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' },
        }),
      );
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]?.thread).toMatchObject({
        threadId: f.threadId,
        title: before?.title,
        objective: before?.objective,
        followState: before?.followState,
        followRevision: before?.followRevision,
      });
      const detail = await Effect.runPromise(queryWorkThreadDetail({ dbPath: f.dbPath, threadId: f.threadId, now }));
      expect(
        detail?.row.links
          .filter((link) => link.detachedAt === null)
          .map((link) => link.key)
          .sort(),
      ).toEqual([PR, SESSION].sort());
    }
    const events = await Effect.runPromise(queryWorkThreadEvents({ dbPath: f.dbPath, threadId: f.threadId }));
    expect(events.filter((event) => event.kind === 'link-added' && event.linkKey === PR)).toHaveLength(1);
  },
);
