import { describe, expect, test } from 'bun:test';
import { makeCaptureWideEventSink, makeTestWideEventSinkLayer } from '@ai-usage/effect-runtime';
import {
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
  sessionDetailRequestFingerprint,
} from '@ai-usage/report-core/session-detail';
import { type SessionQueryRequest, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import { Effect } from 'effect';
import { type RevisionQueryRunnerDependencies, runRevisionQueryForServer } from './revision-query-runner.server';
import { createWebSourceControlRuntime, installWebSourceControlRuntime } from './source-control.server';

const request: SessionDetailRequest = { revision: 'revision-a', rowId: 'row-a' };
const fingerprint = sessionDetailRequestFingerprint(request);
const anchorResult: SessionDetailAnchorResult = {
  anchor: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    projection: {
      calls: 1,
      durationMs: 1000,
      modelSegments: [
        {
          model: 'gpt-5',
          tokens: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 },
        },
      ],
      partial: false,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 },
      tools: 0,
      turns: 1,
    },
    sourceAuthority: 'local-observed',
    sourceSessionId: 'session-a',
    vcs: null,
  },
  requestFingerprint: fingerprint,
  revision: request.revision,
};

const dependenciesReturning = (value: unknown): RevisionQueryRunnerDependencies => ({
  execute: () => Promise.resolve({ ok: true, serializedPayload: JSON.stringify(value) }),
});

const sessionRequest: SessionQueryRequest = {
  campaigns: true,
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], query: '' },
  pageSize: 20,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'date' }],
};
const sessionFingerprint = sessionQueryFingerprint(sessionRequest);
const emptySessionPage = {
  itemCount: 0,
  items: [],
  nextCursor: null,
  requestFingerprint: sessionFingerprint,
  revision: sessionRequest.revision,
  sessionCount: 0,
};

describe('revision query runner server session detail anchor', () => {
  test('parses the exact request and successful bounded-runner result', async () => {
    const executions: unknown[] = [];
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: (execution) => {
        executions.push(execution);
        return Promise.resolve({ ok: true, serializedPayload: JSON.stringify(anchorResult) });
      },
    });

    expect(executions).toEqual([
      {
        kind: 'session-detail-anchor',
        revision: request.revision,
        serializedRequest: JSON.stringify(request),
      },
    ]);
    expect(result).toEqual({
      data: anchorResult,
      ok: true,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });

  test('maps fingerprint and revision result mismatches to QueryFailed', async () => {
    for (const invalidResult of [
      { ...anchorResult, requestFingerprint: 'session-detail-v2:wrong' },
      { ...anchorResult, revision: 'revision-b' },
    ]) {
      const result = await runRevisionQueryForServer(
        'session-detail-anchor',
        request,
        dependenciesReturning(invalidResult),
      );
      expect(result).toMatchObject({
        error: { revision: request.revision, tag: 'QueryFailed' },
        ok: false,
        requestFingerprint: fingerprint,
        revision: request.revision,
      });
    }
  });

  test('maps a missing lease to RevisionExpired without parsing a result', async () => {
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: () => Promise.resolve({ message: 'Revision expired', ok: false }),
    });

    expect(result).toEqual({
      error: { message: 'Revision expired', revision: request.revision, tag: 'RevisionExpired' },
      ok: false,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });

  test('maps bounded process failures to QueryFailed', async () => {
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: () => Promise.reject(new Error('bounded runner failed')),
    });

    expect(result).toEqual({
      error: { message: 'bounded runner failed', revision: request.revision, tag: 'QueryFailed' },
      ok: false,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });

  test('logs an expired sessions revision as a failed business boundary', async () => {
    const sink = makeCaptureWideEventSink();
    const runtime = createWebSourceControlRuntime({
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false }) },
      sources: new Map(),
      wideEventSinkLayer: makeTestWideEventSinkLayer(sink),
    });
    const uninstall = installWebSourceControlRuntime(runtime);

    try {
      const result = await runRevisionQueryForServer('sessions', sessionRequest, {
        execute: () => Promise.resolve({ message: 'Revision expired', ok: false }),
      });

      expect(result.ok).toBe(false);
      const sessionEvents = sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]?.outcome).toBe('failure');
      expect(sessionEvents[0]?.annotations.failureKind).toBe('revision-expired');
    } finally {
      uninstall();
      await runtime.dispose();
    }
  });

  test('keeps sessions parsing inside the boundary so the protocol result and event agree', async () => {
    const sink = makeCaptureWideEventSink();
    const runtime = createWebSourceControlRuntime({
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false }) },
      sources: new Map(),
      wideEventSinkLayer: makeTestWideEventSinkLayer(sink),
    });
    const uninstall = installWebSourceControlRuntime(runtime);

    try {
      const result = await runRevisionQueryForServer('sessions', sessionRequest, {
        execute: () => Promise.resolve({ ok: true, serializedPayload: '{invalid-json' }),
      });

      expect(result).toEqual({
        error: expect.objectContaining({ revision: sessionRequest.revision, tag: 'QueryFailed' }),
        ok: false,
        requestFingerprint: sessionFingerprint,
        revision: sessionRequest.revision,
      });
      const sessionEvents = sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]?.outcome).toBe('failure');
      expect(sessionEvents[0]?.annotations.failureKind).toBe('query-failed');
      expect(sessionEvents[0]?.services.map(({ name }) => name)).toEqual(['revision.execute', 'revision.parse']);
    } finally {
      uninstall();
      await runtime.dispose();
    }
  });

  test('records sessions execution phases and bounded result summaries on success', async () => {
    const sink = makeCaptureWideEventSink();
    const runtime = createWebSourceControlRuntime({
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false }) },
      sources: new Map(),
      wideEventSinkLayer: makeTestWideEventSinkLayer(sink),
    });
    const uninstall = installWebSourceControlRuntime(runtime);

    try {
      const result = await runRevisionQueryForServer('sessions', sessionRequest, {
        execute: () =>
          Promise.resolve({
            diagnostics: { boundedRunnerMs: 12, leaseWaitMs: 3 },
            ok: true,
            serializedPayload: JSON.stringify(emptySessionPage),
          }),
      });

      expect(result).toEqual({
        data: emptySessionPage,
        ok: true,
        requestFingerprint: sessionFingerprint,
        revision: sessionRequest.revision,
      });
      const event = sink.events().find(({ boundary }) => boundary === 'web.sessions.read');
      expect(event?.outcome).toBe('success');
      expect(event?.annotations).toMatchObject({
        hasCursor: false,
        hasMore: false,
        itemCount: 0,
        pageSize: 20,
        queryKind: 'sessions',
        sessionCount: 0,
      });
      expect(event?.services.map(({ name }) => name)).toEqual(['revision.execute', 'revision.parse']);
      expect(event?.services[0]?.annotations).toEqual({ boundedRunnerMs: 12, leaseWaitMs: 3 });
    } finally {
      uninstall();
      await runtime.dispose();
    }
  });

  test('classifies invalid sessions identities and dependency rejection as query failures', async () => {
    const invalidPayloads = [
      { ...emptySessionPage, requestFingerprint: 'session-query-v1:wrong' },
      { ...emptySessionPage, revision: 'revision-b' },
    ];
    const executions: RevisionQueryRunnerDependencies[] = [
      ...invalidPayloads.map(dependenciesReturning),
      { execute: () => Promise.reject(new Error('fixture runner failed')) },
    ];

    for (const dependencies of executions) {
      const sink = makeCaptureWideEventSink();
      const runtime = createWebSourceControlRuntime({
        policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
        publication: { publish: Effect.succeed({ changed: false }) },
        sources: new Map(),
        wideEventSinkLayer: makeTestWideEventSinkLayer(sink),
      });
      const uninstall = installWebSourceControlRuntime(runtime);
      try {
        const result = await runRevisionQueryForServer('sessions', sessionRequest, dependencies);
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.error.tag).toBe('QueryFailed');
        const events = sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
        expect(events).toHaveLength(1);
        expect(events[0]?.outcome).toBe('failure');
        expect(events[0]?.annotations.failureKind).toBe('query-failed');
      } finally {
        uninstall();
        await runtime.dispose();
      }
    }
  });
});
