import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { assembleReport } from '@ai-usage/report-data';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { queryWorkContext } from '@ai-usage/report-data/work-context-read';
import { queryCodexWorkObservations, queryReportRows } from '@ai-usage/usage-store/reader';
import { publishServedReportRevision, updateUsageMachineLabel, usageStorePath } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createScheduledSourceRegistry } from './source-adapters';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const at = (second: number) => canonicalInstantFromDate(new Date(Date.UTC(2026, 9, 22, 10, 0, second)));
const machine = { id: 'native-codex-machine', label: 'Synthetic native Codex fixture' };
const event = (second: number, type: string, payload: Record<string, unknown>) => ({
  timestamp: at(second),
  type,
  payload,
});
const ask = (id: string, second: number, questions: readonly Record<string, unknown>[], tool = 'request_user_input') =>
  event(second, 'response_item', {
    type: 'function_call',
    name: tool,
    call_id: id,
    arguments: JSON.stringify({ questions }),
  });
const output = (id: string, second: number, result: unknown) =>
  event(second, 'response_item', {
    type: 'function_call_output',
    call_id: id,
    output: typeof result === 'string' ? result : JSON.stringify(result),
  });

// Native synchronous payloads are qualified against the installed 0.163.0 schema, not a captured
// user's answer. Async request/accepted envelopes match the separately inspected native trace.
test('C01-C05/A03-A04: existing Codex source, auxiliary store, served families and work.context preserve request attribution', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-work-chain-'));
  try {
    const directory = path.join(home, '.codex', 'sessions', '2026');
    mkdirSync(directory, { recursive: true });
    const writeSession = (id: string, signals: readonly ReturnType<typeof event>[], parent?: string) => {
      const events = [
        event(0, 'session_meta', {
          id,
          timestamp: at(0),
          cwd: '/work/fixture',
          originator: 'Codex Desktop',
          source: parent === undefined ? 'vscode' : { subagent: { thread_spawn: { parent_thread_id: parent } } },
          thread_source: parent === undefined ? 'user' : 'subagent',
        }),
        event(1, 'event_msg', { type: 'task_started', turn_id: id, started_at: Date.parse(at(1)) / 1000 }),
        event(2, 'turn_context', { turn_id: id, model: 'gpt-5' }),
        ...signals,
        event(20, 'event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, total_tokens: 120 },
          },
        }),
        event(21, 'event_msg', { type: 'task_complete', turn_id: id }),
      ];
      writeFileSync(
        path.join(directory, `${id}.jsonl`),
        `${events.map((value) => JSON.stringify(value)).join('\n')}\n`,
      );
    };
    writeSession('main', [
      ask('async', 3, [{ title: 'ASYNC_NATIVE_QUESTION' }], 'request_user_input_async'),
      output('async', 4, { accepted: true }),
      ask('q1', 5, [{ id: 'choice', question: 'Choisir le seuil ?' }]),
      ask('q2', 6, [{ id: 'choice', question: 'Publier maintenant ?' }]),
      output('q1', 7, { answers: { choice: { answers: ['PRIVATE_ANSWER_NEVER_PERSISTED'] } } }),
      ask('multi', 8, [
        { id: 'threshold', question: 'Quel seuil ?' },
        { id: 'publish', question: 'Confirmer la publication ?' },
      ]),
      output('multi', 9, { answers: { threshold: { answers: ['10'] } } }),
      event(10, 'event_msg', { type: 'user_message', message: 'Je reviens demain. Ne publie rien.' }),
    ]);
    writeSession(
      'worker',
      [
        ask('child', 3, [{ title: 'Question du travailleur' }], 'request_user_input_async'),
        output('child', 4, { accepted: true }),
      ],
      'main',
    );
    writeSession('rejected', [
      ask('unavailable', 3, [{ id: 'q', question: 'Never presented' }]),
      output('unavailable', 4, 'request_user_input is unavailable in Default mode'),
    ]);
    writeSession('unknown', []);

    const dbPath = usageStorePath(home);
    const registry = await Effect.runPromise(
      createScheduledSourceRegistry({ machine, dbPath, now: () => NOW }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    const source = registry.get('codex.sessions');
    if (source === undefined) {
      throw new Error('expected existing Codex scheduled source');
    }
    const first = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
    const second = await Effect.runPromise(source.run({ reportProgress: () => Effect.void }));
    expect(first).toMatchObject({ changed: true, inputCount: 4, outputCount: 4 });
    expect(second).toMatchObject({ changed: false, servedProjectionChanged: false });
    const native = await Effect.runPromise(
      queryCodexWorkObservations({
        dbPath,
        machineId: machine.id,
        sourceSessionIds: ['main', 'worker', 'rejected', 'unknown'],
      }),
    );
    expect(native.skipped).toBe(0);
    expect(native.observations).toHaveLength(4);
    expect(JSON.stringify(native)).not.toContain('PRIVATE_ANSWER_NEVER_PERSISTED');
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(stored.rows).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain('ASYNC_NATIVE_QUESTION');
    const { payload } = assembleReport({
      configuredProjectGroups: [],
      generatedAt: NOW,
      options: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
      projectGroups: [],
      rows: stored.rows,
      timeZone: 'UTC',
      warnings: [],
    });
    const { rows, tableRows: _tableRows, ...support } = payload;
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
    await Effect.runPromise(
      publishServedReportRevision({
        dbPath,
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: payload.generatedAt,
          projectAliases: [],
          projectGroupConfigs: [],
          rows,
          sourceAuthorities: rows.map(() => 'local-observed' as const),
          support: support as FocusedReportSupport,
        }),
        now: NOW.getTime(),
        revision: 'codex-work-chain',
        ttlMs: 300_000,
      }),
    );

    const attention = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: machine.id, now: NOW }));
    expect(attention.roots).toHaveLength(3);
    const main = attention.roots.find((root) => root.key.sourceSessionId === 'main');
    expect(main).toMatchObject({
      attention: 'human-request',
      declared: null,
      reconsidered: true,
      children: { count: 1 },
    });
    const requests = main?.facts.filter((fact) => fact.kind === 'codex-user-request') ?? [];
    expect(requests).toHaveLength(5);
    expect(requests.find((fact) => fact.request.callId === 'async')?.request).toMatchObject({
      acknowledgedAt: at(4),
      questions: [{ id: null, answeredAt: null }],
    });
    expect(requests.find((fact) => fact.request.callId === 'q1')?.request.questions[0]?.answeredAt).toBe(at(7));
    expect(requests.find((fact) => fact.request.callId === 'q2')?.request.questions[0]?.answeredAt).toBeNull();
    expect(
      requests
        .find((fact) => fact.request.callId === 'multi')
        ?.request.questions.map((question) => question.answeredAt),
    ).toEqual([at(9), null]);
    expect(requests.find((fact) => fact.request.callId === 'child')?.sourceSessionId).toBe('worker');
    expect(
      attention.roots
        .filter((root) => root.key.sourceSessionId !== 'main')
        .every((root) => root.attention === 'not-observable'),
    ).toBe(true);

    const context = await Effect.runPromise(
      queryWorkContext({
        dbPath,
        machineId: machine.id,
        now: NOW,
        scope: { kind: 'checkout', checkoutPath: '/work/fixture' },
      }),
    );
    expect(context.coverage.scopeAppliedBeforeBounds).toBe(true);
    expect(context.coverage.harnesses.codex).toMatchObject({ inScope: 3, reads: 'native-requests' });
    expect(context.waiting).toHaveLength(1);
    expect(context.waiting[0]?.root.key.sourceSessionId).toBe('main');
    expect(context.waiting[0]?.declared).toBeNull();
    expect(
      context.waiting[0]?.readings.some((reading) =>
        reading.evidence.some(
          (fact) =>
            fact.kind === 'codex-user-request' && fact.at === at(8) && fact.provenance?.source === 'codex-rollout',
        ),
      ),
    ).toBe(true);
    expect(context.decisions).toHaveLength(1);
    expect(context.decisions[0]?.evidence[0]).toMatchObject({ kind: 'codex-user-request', at: at(5) });
    expect(context.sessions).toHaveLength(3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
