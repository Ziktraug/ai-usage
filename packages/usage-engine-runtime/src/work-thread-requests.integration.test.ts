import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { parsePullRequestObservation } from '@ai-usage/report-core/work-attention';
import { pullRequestLinkKey, sessionLinkKey } from '@ai-usage/report-core/work-thread';
import { deriveWorkThreadSituation } from '@ai-usage/report-core/work-thread-situation';
import { createStoredReportCapture } from '@ai-usage/report-data';
import { queryWorkThreadDetail, queryWorkThreadList } from '@ai-usage/report-data/work-thread-read';
import {
  publishServedReportRevision,
  queryCodexWorkObservations,
  updateUsageMachineLabel,
  usageStorePath,
} from '@ai-usage/usage-store/testing';
import { applyWorkThreadCommand, importPullRequestObservations } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createScheduledSourceRegistry, type SourceRunContext } from './source-adapters';
import { isolatedSourceOptions } from './source-test-fixtures';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const MACHINE = { id: 'work-thread-request-machine', label: 'Synthetic request machine' };
const NOW = new Date('2026-07-03T12:00:00.000Z');
const at = (minute: number) => canonicalInstantFromDate(new Date(Date.UTC(2026, 6, 2, 9, minute)));
const run = Effect.runPromise;
const context: SourceRunContext = { reportProgress: () => Effect.void };
const native = (minute: number, payload: Record<string, unknown>, type = 'response_item') =>
  `${JSON.stringify({ timestamp: at(minute), type, payload })}\n`;
const question = (callId: string, minute: number, questions: unknown[], tool = 'request_user_input') =>
  native(minute, { type: 'function_call', call_id: callId, name: tool, arguments: JSON.stringify({ questions }) });
const answer = (callId: string, minute: number, output: unknown) =>
  native(minute, { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) });

const fixture = async (advanceClock = false) => {
  const home = await mkdtemp(path.join(tmpdir(), 'work-thread-native-requests-'));
  roots.push(home);
  const storage = createLocalHistoryStorage(home);
  await run(writeMachineConfig(MACHINE).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  const seeded = await seedHarnessHome(home, { harnesses: ['codex'] });
  let clock = NOW;
  const registry = await run(
    createScheduledSourceRegistry({
      ...isolatedSourceOptions,
      codexLiveAvailable: () => false,
      machine: MACHINE,
      now: () => {
        if (advanceClock) {
          clock = new Date(clock.getTime() + 1);
        }
        return clock;
      },
    }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
  );
  const source = registry.get('codex.sessions');
  if (!source) {
    throw new Error('Missing Codex fixture source');
  }
  const dbPath = usageStorePath(home);
  const collect = async () => {
    await run(source.run(context));
  };
  await collect();
  const capture = await run(
    createStoredReportCapture({
      config: {},
      dbPath,
      generatedAt: NOW,
      harness: null,
      includeCursor: false,
      machine: MACHINE,
      options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
    }),
  );
  const { rows, tableRows: _table, ...support } = capture.payload;
  await run(updateUsageMachineLabel({ dbPath, machine: MACHINE, updatedAt: NOW }));
  await run(
    publishServedReportRevision({
      dbPath,
      now: NOW.getTime(),
      revision: 'native-task-request-fixture',
      ttlMs: 100_000,
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: capture.payload.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows,
        sourceAuthorities: capture.rowSourceAuthorities,
        support: support as FocusedReportSupport,
      }),
    }),
  );
  const result = await run(
    applyWorkThreadCommand({
      dbPath,
      machineId: MACHINE.id,
      now: at(4),
      command: {
        commandId: randomUUID(),
        op: 'create',
        title: 'Analysis without artifact',
        intent: 'analysis',
        objective: null,
        projectLabel: null,
        links: [
          {
            kind: 'session',
            key: sessionLinkKey({ machineId: MACHINE.id, harness: 'codex', sessionId: seeded.ids.codexRoot }),
          },
        ],
      },
    }),
  );
  if (!result.ok) {
    throw new Error(result.failure);
  }
  const read = async () => {
    const detail = await run(queryWorkThreadDetail({ dbPath, threadId: result.threadId, now: NOW }));
    if (!detail) {
      throw new Error('Task missing');
    }
    return detail;
  };
  return {
    home,
    storage,
    registry,
    seeded,
    dbPath,
    collect,
    read,
    threadId: result.threadId,
    setNow: (value: Date) => {
      clock = value;
    },
  };
};

test('an analysis task retains qualified native requests and removes only an attributable answer after recollection', async () => {
  const f = await fixture();
  await appendFile(
    f.seeded.paths.codexRootRollout,
    question('decision', 5, [
      { id: 'q1', question: 'Choose direction?' },
      { id: 'q2', question: 'Choose scope?' },
    ]),
  );
  await f.collect();
  let detail = await f.read();
  let situation = deriveWorkThreadSituation(detail.row, NOW);
  expect(situation.remainders.filter((item) => item.kind === 'native-request')).toHaveLength(2);
  expect(situation.hint).not.toBe('ready-to-close');
  expect(detail.row.nativeRequests.map((item) => item.questionId)).toEqual(['q1', 'q2']);
  expect(detail.episodes[0]?.nativeRequests).toHaveLength(2);
  const list = await run(
    queryWorkThreadList({
      dbPath: f.dbPath,
      now: NOW,
      query: { cursor: null, limit: 50, project: null, search: null, tab: 'open' },
    }),
  );
  expect(list.rows[0]?.nativeRequests).toEqual(detail.row.nativeRequests);
  await appendFile(
    f.seeded.paths.codexRootRollout,
    native(6, { type: 'user_message', message: 'Unrelated later message' }, 'event_msg') +
      answer('decision', 7, { answers: { q1: { answers: ['Direction A'] } } }),
  );
  await f.collect();
  detail = await f.read();
  situation = deriveWorkThreadSituation(detail.row, NOW);
  expect(situation.remainders.filter((item) => item.kind === 'native-request')).toHaveLength(1);
  expect(detail.row.nativeRequests.find((item) => item.questionId === 'q1')?.state).toBe('answered');
  expect(detail.row.nativeRequests.find((item) => item.questionId === 'q2')?.state).toBe('open');
  expect(detail.row.thread.followState).toBe('following');
  const nativeBefore = await run(
    queryCodexWorkObservations({ dbPath: f.dbPath, machineId: MACHINE.id, sourceSessionIds: [f.seeded.ids.codexRoot] }),
  );
  const closed = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(8),
      command: {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId: f.threadId,
        expectedRevision: detail.row.thread.followRevision,
        to: 'done',
        reason: null,
        waitingFor: null,
        waitingOn: null,
        acknowledgedRemainders: situation.remainders.map((item) => item.key),
      },
    }),
  );
  expect(closed.ok).toBe(true);
  detail = await f.read();
  expect(detail.row.thread.followState).toBe('done');
  expect(detail.events.some((event) => event.acknowledgedRemainders.some((item) => item.includes('q2')))).toBe(true);
  expect(
    await run(
      queryCodexWorkObservations({
        dbPath: f.dbPath,
        machineId: MACHINE.id,
        sourceSessionIds: [f.seeded.ids.codexRoot],
      }),
    ),
  ).toEqual(nativeBefore);
  await appendFile(
    f.seeded.paths.codexRootRollout,
    answer('decision', 9, { answers: { q2: { answers: ['Scope B'] } } }),
  );
  await f.collect();
  detail = await f.read();
  expect(
    deriveWorkThreadSituation(detail.row, NOW).remainders.filter((item) => item.kind === 'native-request'),
  ).toHaveLength(0);
  expect(detail.row.thread.followState).toBe('done');
});

test('native acceptance, unrelated messages, a child completion and a merged PR do not settle a request; qualified children are unique and detachable', async () => {
  const f = await fixture();
  const childFile = path.join(
    path.dirname(f.seeded.paths.codexRootRollout),
    `rollout-2026-07-02T09-10-00-${f.seeded.ids.codexChild}.jsonl`,
  );
  await appendFile(
    childFile,
    native(
      14,
      { type: 'task_started', turn_id: 'new-owned-turn', started_at: Date.parse(at(14)) / 1000 },
      'event_msg',
    ) +
      native(14, { turn_id: 'new-owned-turn', model: 'gpt-5' }, 'turn_context') +
      question('child-call', 15, [{ id: 'choice', question: 'Child decision?' }]) +
      native(16, { type: 'task_complete', turn_id: 'new-owned-turn' }, 'event_msg'),
  );
  await appendFile(
    f.seeded.paths.codexRootRollout,
    question('async', 5, [{ title: 'Choose an option?' }], 'request_user_input_async') +
      answer('async', 6, { accepted: true }) +
      native(7, { type: 'user_message', message: 'Unrelated instruction' }, 'event_msg') +
      native(8, { type: 'task_complete', turn_id: 'fixture-finished' }, 'event_msg'),
  );
  await f.collect();
  const linked = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(16),
      command: {
        commandId: randomUUID(),
        op: 'link',
        threadId: f.threadId,
        kind: 'session',
        key: sessionLinkKey({ machineId: MACHINE.id, harness: 'codex', sessionId: f.seeded.ids.codexChild }),
      },
    }),
  );
  expect(linked.ok).toBe(true);
  const merged = parsePullRequestObservation({
    machineId: MACHINE.id,
    host: 'github.com',
    repository: 'fixture/repo',
    number: 7,
    observedAt: at(17),
    outcome: 'observed',
    state: 'MERGED',
    mergedAt: at(17),
  });
  if (!merged) {
    throw new Error('Invalid merged fixture');
  }
  await run(importPullRequestObservations({ dbPath: f.dbPath, observations: [merged] }));
  await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(17),
      command: {
        commandId: randomUUID(),
        op: 'link',
        threadId: f.threadId,
        kind: 'pull-request',
        key: pullRequestLinkKey(merged),
      },
    }),
  );
  let detail = await f.read();
  expect(detail.row.nativeRequests).toHaveLength(2);
  expect(detail.row.nativeRequests.every((item) => item.state === 'open')).toBe(true);
  expect(new Set(detail.row.nativeRequests.map((item) => item.key)).size).toBe(2);
  expect(detail.row.nativeRequests.find((item) => item.callId === 'async')).toMatchObject({
    questionId: null,
    state: 'open',
  });
  const waiting = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(17),
      command: {
        commandId: randomUUID(),
        op: 'set-follow-state',
        threadId: f.threadId,
        expectedRevision: detail.row.thread.followRevision,
        to: 'waiting',
        reason: null,
        waitingFor: 'External review',
        waitingOn: null,
        acknowledgedRemainders: [],
      },
    }),
  );
  expect(waiting.ok).toBe(true);
  detail = await f.read();
  expect(deriveWorkThreadSituation(detail.row, NOW).reason).toBe('native-request');
  expect(detail.row.thread.followState).toBe('waiting');
  const childLink = detail.row.links.find(
    (item) =>
      item.key === sessionLinkKey({ machineId: MACHINE.id, harness: 'codex', sessionId: f.seeded.ids.codexChild }),
  );
  if (!childLink) {
    throw new Error('Missing child link');
  }
  await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(18),
      command: { commandId: randomUUID(), op: 'detach-link', threadId: f.threadId, linkId: childLink.linkId },
    }),
  );
  detail = await f.read();
  expect(detail.row.nativeRequests.map((item) => item.sourceSessionId)).toEqual([f.seeded.ids.codexRoot]);
  const other = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(19),
      command: {
        commandId: randomUUID(),
        op: 'create',
        title: 'Unrelated same-project task',
        intent: 'analysis',
        objective: null,
        projectLabel: null,
        links: [
          {
            kind: 'session',
            key: sessionLinkKey({ machineId: 'other-machine', harness: 'codex', sessionId: f.seeded.ids.codexRoot }),
          },
        ],
      },
    }),
  );
  if (!other.ok) {
    throw new Error(other.failure);
  }
  const unrelated = await run(queryWorkThreadDetail({ dbPath: f.dbPath, threadId: other.threadId, now: NOW }));
  expect(unrelated?.row.nativeRequests).toEqual([]);
  expect(deriveWorkThreadSituation(unrelated!.row, NOW).hint).not.toBe('ready-to-close');
});

test('Claude native declarations retain stable observation identity and never treat later free text as an attributable answer', async () => {
  const f = await fixture();
  const seeded = await seedHarnessHome(f.home, {
    harnesses: ['claude'],
    claudeDesktopSessions: 'minimal',
    claudeDesktopEpoch: NOW,
  });
  const desktop = seeded.claudeDesktop;
  if (!desktop) {
    throw new Error('Missing Claude registry');
  }
  const transcriptSource = f.registry.get('claude.sessions');
  if (!transcriptSource) {
    throw new Error('Missing Claude transcript source');
  }
  await run(transcriptSource.run(context));
  const capture = await run(
    createStoredReportCapture({
      config: {},
      dbPath: f.dbPath,
      generatedAt: NOW,
      harness: null,
      includeCursor: false,
      machine: MACHINE,
      options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
    }),
  );
  const { rows, tableRows: _table, ...support } = capture.payload;
  await run(
    publishServedReportRevision({
      dbPath: f.dbPath,
      now: NOW.getTime(),
      revision: 'native-claude-task-fixture',
      ttlMs: 100_000,
      assemble: () => ({
        configFingerprint: 'd'.repeat(64),
        generatedAt: capture.payload.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows,
        sourceAuthorities: capture.rowSourceAuthorities,
        support: support as FocusedReportSupport,
      }),
    }),
  );
  const source = f.registry.get('claude.desktop-sessions');
  if (!source) {
    throw new Error('Missing Desktop source');
  }
  await run(source.run(context));
  const created = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(4),
      command: {
        commandId: randomUUID(),
        op: 'create',
        title: 'Claude analysis',
        intent: 'analysis',
        objective: null,
        projectLabel: null,
        links: [
          {
            kind: 'session',
            key: sessionLinkKey({ machineId: MACHINE.id, harness: 'claude', sessionId: seeded.ids.claude }),
          },
        ],
      },
    }),
  );
  if (!created.ok) {
    throw new Error(created.failure);
  }
  const read = async () => {
    const result = await run(queryWorkThreadDetail({ dbPath: f.dbPath, threadId: created.threadId, now: NOW }));
    if (!result) {
      throw new Error('Task missing');
    }
    return result;
  };
  let detail = await read();
  expect(detail.row.nativeRequests).toHaveLength(1);
  const original = detail.row.nativeRequests[0];
  expect(original).toMatchObject({
    state: 'open',
    harness: 'claude',
    callId: null,
    questionId: null,
    evidence: 'claude-desktop-declaration',
  });
  expect(deriveWorkThreadSituation(detail.row, NOW).hint).not.toBe('ready-to-close');
  const files = await readdir(desktop.registryDirectory, { recursive: true });
  const relative = files.find((candidate) => candidate.endsWith(`${desktop.ids.blockedRoot}.json`));
  if (!relative) {
    throw new Error('Missing blocked native file');
  }
  const file = path.join(desktop.registryDirectory, relative);
  const nativeDocument = JSON.parse(await readFile(file, 'utf8'));
  nativeDocument.latestUserFrameAt = NOW.getTime() - 60_000;
  nativeDocument.lastActivityAt = NOW.getTime() - 30_000;
  await writeFile(file, JSON.stringify(nativeDocument));
  await run(source.run(context));
  detail = await read();
  expect(detail.row.nativeRequests[0]?.key).toBe(original?.key);
  expect(detail.row.nativeRequests[0]?.state).toBe('open');
  nativeDocument.postTurnSummary = {
    status_category: 'completed',
    status_detail: 'A later summary without a question',
    needs_action: '',
    summarizes_uuid: 'replacement-declaration',
  };
  nativeDocument.lastActivityAt = NOW.getTime() - 10_000;
  await writeFile(file, JSON.stringify(nativeDocument));
  await run(source.run(context));
  detail = await read();
  expect(detail.row.nativeRequests).toHaveLength(1);
  expect(detail.row.nativeRequests[0]).toMatchObject({ key: original?.key, state: 'uncertain', answeredAt: null });
  expect(deriveWorkThreadSituation(detail.row, NOW).hint).not.toBe('ready-to-close');
  expect(detail.episodes[0]?.nativeRequests).toHaveLength(1);
  // "Review ready" with no action asked is a report, not a request waiting on the operator.
  nativeDocument.postTurnSummary = {
    status_category: 'review_ready',
    status_detail: 'PR #1480 draft; CI running, auto-fix on',
    needs_action: '',
    summarizes_uuid: 'review-ready-report',
  };
  nativeDocument.lastActivityAt = NOW.getTime() - 5000;
  await writeFile(file, JSON.stringify(nativeDocument));
  await run(source.run(context));
  detail = await read();
  expect(detail.row.nativeRequests.map((request) => request.key)).toEqual([original?.key ?? 'missing request']);
  for (const sessionId of [f.seeded.ids.codexRoot, f.seeded.ids.codexChild]) {
    await run(
      applyWorkThreadCommand({
        dbPath: f.dbPath,
        machineId: MACHINE.id,
        now: at(19),
        command: {
          commandId: randomUUID(),
          op: 'link',
          threadId: created.threadId,
          kind: 'session',
          key: sessionLinkKey({ machineId: MACHINE.id, harness: 'codex', sessionId }),
        },
      }),
    );
    const rollout =
      sessionId === f.seeded.ids.codexRoot
        ? f.seeded.paths.codexRootRollout
        : path.join(path.dirname(f.seeded.paths.codexRootRollout), `rollout-2026-07-02T09-10-00-${sessionId}.jsonl`);
    let lines =
      native(
        19,
        { type: 'task_started', turn_id: 'owned-bounded-requests', started_at: Date.parse(at(19)) / 1000 },
        'event_msg',
      ) + native(19, { turn_id: 'owned-bounded-requests', model: 'gpt-5' }, 'turn_context');
    for (let index = 0; index < 16; index++) {
      const questions = [0, 1, 2].map((q) => ({ id: `q${q}`, question: `Answered question ${index}-${q}?` }));
      lines +=
        question(`bounded-${index}`, 20 + index * 2, questions) +
        answer(`bounded-${index}`, 21 + index * 2, {
          answers: { q0: { answers: ['yes'] }, q1: { answers: ['yes'] }, q2: { answers: ['yes'] } },
        });
    }
    await appendFile(rollout, lines);
  }
  await f.collect();
  detail = await read();
  expect(detail.row.nativeRequests).toHaveLength(64);
  expect(detail.row.nativeRequests.find((request) => request.key === original?.key)?.state).toBe('uncertain');
  expect(detail.row.nativeRequestCoverage).toBe('partial');
  nativeDocument.priorCliSessionIds = [seeded.ids.claude];
  nativeDocument.cliSessionId = 'replacement-cli-session';
  nativeDocument.postTurnSummary = {
    status_category: 'blocked',
    status_detail: 'New session asks',
    needs_action: 'Choose for the new session?',
    summarizes_uuid: 'new-cli-question',
  };
  await writeFile(file, JSON.stringify(nativeDocument));
  await run(source.run(context));
  detail = await read();
  expect(detail.row.nativeRequests.filter((request) => request.harness === 'claude')).toEqual([]);
  expect(detail.row.nativeRequestCoverage).toBe('partial');
});

test('incomplete native request coverage stays unknown, and equal question text does not collapse distinct calls', async () => {
  const f = await fixture();
  await appendFile(
    f.seeded.paths.codexRootRollout,
    question('call-a', 5, [{ id: 'choice', question: 'Same question?' }]) +
      question('call-b', 6, [{ id: 'choice', question: 'Same question?' }]),
  );
  await f.collect();
  let detail = await f.read();
  expect(detail.row.nativeRequests).toHaveLength(2);
  expect(new Set(detail.row.nativeRequests.map((item) => item.key)).size).toBe(2);
  await appendFile(
    f.seeded.paths.codexRootRollout,
    answer('call-a', 7, { answers: { choice: { answers: ['Yes'] } } }) +
      answer('call-b', 8, { answers: { choice: { answers: ['No'] } } }) +
      question('malformed', 9, [{ question: 'Missing native identity' }]),
  );
  await f.collect();
  detail = await f.read();
  expect(detail.row.nativeRequestCoverage).toBe('partial');
  expect(deriveWorkThreadSituation(detail.row, NOW).hint).not.toBe('ready-to-close');
  expect(deriveWorkThreadSituation(detail.row, NOW).remainders.some((item) => item.kind === 'source-unknown')).toBe(
    true,
  );
});

test('a rejected Claude registry sweep cannot reuse an older empty declaration as complete coverage', async () => {
  const f = await fixture(true);
  const seeded = await seedHarnessHome(f.home, {
    harnesses: ['claude'],
    claudeDesktopSessions: 'minimal',
    claudeDesktopEpoch: NOW,
  });
  const desktop = seeded.claudeDesktop;
  if (!desktop) {
    throw new Error('Missing Desktop registry');
  }
  const files = await readdir(desktop.registryDirectory, { recursive: true });
  const relative = files.find((candidate) => candidate.endsWith(`${desktop.ids.blockedRoot}.json`));
  if (!relative) {
    throw new Error('Missing native file');
  }
  const nativePath = path.join(desktop.registryDirectory, relative);
  for (const candidate of files) {
    if (path.basename(candidate).startsWith('local_') && candidate !== relative) {
      await rm(path.join(desktop.registryDirectory, candidate));
    }
  }
  const document = JSON.parse(await readFile(nativePath, 'utf8'));
  document.postTurnSummary = {
    status_category: 'completed',
    status_detail: 'Analysis complete',
    needs_action: '',
    summarizes_uuid: 'no-question',
  };
  await writeFile(nativePath, JSON.stringify(document));
  const source = f.registry.get('claude.desktop-sessions');
  if (!source) {
    throw new Error('Missing Desktop source');
  }
  await run(source.run(context));
  const created = await run(
    applyWorkThreadCommand({
      dbPath: f.dbPath,
      machineId: MACHINE.id,
      now: at(4),
      command: {
        commandId: randomUUID(),
        op: 'create',
        title: 'Completed analysis',
        intent: 'analysis',
        objective: null,
        projectLabel: null,
        links: [
          {
            kind: 'session',
            key: sessionLinkKey({ machineId: MACHINE.id, harness: 'claude', sessionId: seeded.ids.claude }),
          },
        ],
      },
    }),
  );
  if (!created.ok) {
    throw new Error(created.failure);
  }
  const read = async () => {
    const detail = await run(queryWorkThreadDetail({ dbPath: f.dbPath, threadId: created.threadId, now: NOW }));
    if (!detail) {
      throw new Error('Missing task');
    }
    return detail;
  };
  const initial = await read();
  expect(initial.row.nativeRequestCoverage).toBe('complete');
  f.setNow(new Date(NOW.getTime() + 60_000));
  const unchanged = await run(source.run(context));
  expect(unchanged.changed).toBe(false);
  expect(unchanged.wake).toBeUndefined();
  const refreshed = await read();
  expect(refreshed.row.nativeRequestCoverage).toBe('complete');
  expect(refreshed.row.lastActivityAt).toBe(initial.row.lastActivityAt);
  expect(refreshed.events).toEqual(initial.events);
  expect(refreshed.row.afterDone).toEqual(initial.row.afterDone);
  f.setNow(new Date(NOW.getTime() + 120_000));
  await writeFile(nativePath, 'invalid-json\n');
  await run(source.run(context));
  const detail = await read();
  expect(detail.row.nativeRequestCoverage).toBe('partial');
  expect(deriveWorkThreadSituation(detail.row, NOW).hint).not.toBe('ready-to-close');
  f.setNow(new Date(NOW.getTime() + 180_000));
  await writeFile(nativePath, JSON.stringify(document));
  await run(source.run(context));
  expect((await read()).row.nativeRequestCoverage).toBe('complete');
  f.setNow(new Date(NOW.getTime() + 240_000));
  await rm(nativePath);
  await run(source.run(context));
  expect((await read()).row.nativeRequestCoverage).toBe('partial');
  await writeFile(nativePath, JSON.stringify(document));
  await run(source.run(context));
  expect((await read()).row.nativeRequestCoverage).toBe('complete');
  await rm(desktop.registryDirectory, { recursive: true });
  await run(source.run(context));
  expect((await read()).row.nativeRequestCoverage).toBe('partial');
  expect(deriveWorkThreadSituation((await read()).row, NOW).hint).not.toBe('ready-to-close');
  await mkdir(path.dirname(nativePath), { recursive: true });
  document.postTurnSummary = {
    status_category: 'blocked',
    status_detail: 'Choose the scope',
    needs_action: 'Choose A or B',
    summarizes_uuid: 'pending-choice',
  };
  await writeFile(nativePath, JSON.stringify(document));
  await run(source.run(context));
  const pending = (await read()).row.nativeRequests;
  expect(pending.some((request) => request.state === 'open')).toBe(true);
  const controller = new AbortController();
  const interrupted = await Effect.runPromiseExit(
    source.run({
      signal: controller.signal,
      reportProgress: (progress) => {
        if (progress.phase === 'normalizing') {
          controller.abort();
        }
        return Effect.void;
      },
    }),
  );
  expect(interrupted._tag).toBe('Failure');
  expect((await read()).row.nativeRequestCoverage).toBe('partial');
  expect((await read()).row.nativeRequests).toEqual(pending);
  await run(source.run(context));
  const recovered = await read();
  expect(recovered.row.nativeRequestCoverage).toBe('complete');
  await rm(desktop.registryDirectory, { recursive: true });
  await run(source.run(context));
  expect((await read()).row.nativeRequestCoverage).toBe('partial');
  expect((await read()).row.nativeRequests).toEqual(recovered.row.nativeRequests);
});

test('failed Codex collection coverage keeps historical requests and cannot suggest closing from an old empty observation', async () => {
  const f = await fixture();
  const original = await readFile(f.seeded.paths.codexRootRollout, 'utf8');
  expect((await f.read()).row.nativeRequestCoverage).toBe('complete');
  await writeFile(f.seeded.paths.codexRootRollout, 'invalid-json\n');
  await f.collect();
  let detail = await f.read();
  expect(detail.row.nativeRequestCoverage).toBe('partial');
  expect(deriveWorkThreadSituation(detail.row, NOW).hint).not.toBe('ready-to-close');
  const withRequest = original + question('recovered-request', 5, [{ id: 'choice', question: 'Keep this decision?' }]);
  await writeFile(f.seeded.paths.codexRootRollout, withRequest);
  await f.collect();
  detail = await f.read();
  expect(detail.row.nativeRequestCoverage).toBe('complete');
  expect(detail.row.nativeRequests[0]?.state).toBe('open');
  const requestKey = detail.row.nativeRequests[0]?.key;
  await writeFile(f.seeded.paths.codexRootRollout, 'invalid-json\n');
  await f.collect();
  detail = await f.read();
  expect(detail.row.nativeRequestCoverage).toBe('partial');
  expect(detail.row.nativeRequests[0]).toMatchObject({ key: requestKey, state: 'open' });
  await writeFile(
    f.seeded.paths.codexRootRollout,
    withRequest + answer('recovered-request', 6, { answers: { choice: { answers: ['Keep'] } } }),
  );
  await f.collect();
  detail = await f.read();
  expect(detail.row.nativeRequestCoverage).toBe('complete');
  expect(detail.row.nativeRequests[0]).toMatchObject({ key: requestKey, state: 'answered' });
  expect(detail.row.thread.followState).toBe('following');
});
