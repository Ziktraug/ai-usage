import { describe, expect, test } from 'bun:test';
import { makeCaptureWideEventSink, makeTestWideEventSinkLayer } from '@ai-usage/effect-runtime';
import {
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
  sessionDetailRequestFingerprint,
} from '@ai-usage/report-core/session-detail';
import {
  type SessionQueryRequest,
  type SessionQueryServerResult,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { ManagedRuntime } from 'effect';
import {
  type RevisionQueryKind,
  type RevisionQueryRunnerDependencies,
  runRevisionQueryForServer,
} from './revision-query-runner.server';
import {
  installWebProcessRuntime,
  tryGetWebProcessRuntime,
  type WebProcessRuntime,
  type WebSourceControlPort,
} from './web-process-runtime.server';

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

const dependenciesReturningSerialized = (serializedPayload: string): RevisionQueryRunnerDependencies => ({
  execute: () => Promise.resolve({ ok: true, serializedPayload }),
});

const dependenciesReturning = (value: unknown): RevisionQueryRunnerDependencies =>
  dependenciesReturningSerialized(JSON.stringify(value));

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

const failSourceControlOperation = (): Promise<never> =>
  Promise.reject(new Error('Unexpected source-control operation.'));

const failSourceControlSubscription = (): never => {
  throw new Error('Unexpected source-control subscription.');
};

const failingSourceControlPort: WebSourceControlPort = {
  detectAll: failSourceControlOperation,
  getSnapshot: failSourceControlOperation,
  requestPublication: failSourceControlOperation,
  runAllEnabled: failSourceControlOperation,
  runNow: failSourceControlOperation,
  setEnabled: failSourceControlOperation,
  start: failSourceControlOperation,
  subscribe: failSourceControlSubscription,
};

const makeWebEventRuntimeFixture = () => {
  const sink = makeCaptureWideEventSink();
  const managedRuntime = ManagedRuntime.make(makeTestWideEventSinkLayer(sink));
  let disposal: Promise<void> | undefined;
  const runtime: WebProcessRuntime = {
    dispose: () => {
      disposal ??= managedRuntime.dispose();
      return disposal;
    },
    effects: {
      runEffect: (effect) => managedRuntime.runPromise(effect),
    },
    sourceControl: failingSourceControlPort,
  };
  const uninstall = installWebProcessRuntime(runtime);
  return {
    dispose: async () => {
      uninstall();
      await runtime.dispose();
    },
    sink,
  };
};

interface RevisionQueryParityPath {
  readonly fingerprint: string;
  readonly kind: RevisionQueryKind;
  readonly name: string;
  readonly revision: string;
  readonly run: (dependencies: RevisionQueryRunnerDependencies) => Promise<SessionQueryServerResult<unknown>>;
  readonly serializedRequest: string;
  readonly successfulPayload: unknown;
  readonly wrongFingerprintPayload: unknown;
  readonly wrongRevisionPayload: unknown;
}

const revisionQueryParityPaths: readonly RevisionQueryParityPath[] = [
  {
    fingerprint,
    kind: 'session-detail-anchor',
    name: 'generic session detail',
    revision: request.revision,
    run: (dependencies) => runRevisionQueryForServer('session-detail-anchor', request, dependencies),
    serializedRequest: JSON.stringify(request),
    successfulPayload: anchorResult,
    wrongFingerprintPayload: { ...anchorResult, requestFingerprint: 'session-detail-v2:wrong' },
    wrongRevisionPayload: { ...anchorResult, revision: 'revision-b' },
  },
  {
    fingerprint: sessionFingerprint,
    kind: 'sessions',
    name: 'observed sessions',
    revision: sessionRequest.revision,
    run: async (dependencies) => {
      const fixture = makeWebEventRuntimeFixture();
      try {
        return await runRevisionQueryForServer('sessions', sessionRequest, dependencies);
      } finally {
        await fixture.dispose();
      }
    },
    serializedRequest: JSON.stringify(sessionRequest),
    successfulPayload: emptySessionPage,
    wrongFingerprintPayload: { ...emptySessionPage, requestFingerprint: 'session-query-v1:wrong' },
    wrongRevisionPayload: { ...emptySessionPage, revision: 'revision-b' },
  },
];

const expectedQueryFailure = (path: RevisionQueryParityPath) => ({
  error: { revision: path.revision, tag: 'QueryFailed' },
  ok: false,
  requestFingerprint: path.fingerprint,
  revision: path.revision,
});

describe('revision query runner server', () => {
  for (const queryPath of revisionQueryParityPaths) {
    test(`${queryPath.name} preserves the exact revision query lifecycle`, async () => {
      expect(tryGetWebProcessRuntime()).toBeUndefined();
      const executions: unknown[] = [];
      const successful = await queryPath.run({
        execute: (execution) => {
          executions.push(execution);
          return Promise.resolve({ ok: true, serializedPayload: JSON.stringify(queryPath.successfulPayload) });
        },
      });

      expect(executions).toEqual([
        {
          kind: queryPath.kind,
          revision: queryPath.revision,
          serializedRequest: queryPath.serializedRequest,
        },
      ]);
      expect(successful).toEqual({
        data: queryPath.successfulPayload,
        ok: true,
        requestFingerprint: queryPath.fingerprint,
        revision: queryPath.revision,
      });

      const expired = await queryPath.run({
        execute: () => Promise.resolve({ message: 'Revision expired', ok: false }),
      });
      expect(expired).toEqual({
        error: { message: 'Revision expired', revision: queryPath.revision, tag: 'RevisionExpired' },
        ok: false,
        requestFingerprint: queryPath.fingerprint,
        revision: queryPath.revision,
      });

      const rejected = await queryPath.run({
        execute: () => Promise.reject(new Error('bounded runner failed')),
      });
      expect(rejected).toEqual({
        error: { message: 'bounded runner failed', revision: queryPath.revision, tag: 'QueryFailed' },
        ok: false,
        requestFingerprint: queryPath.fingerprint,
        revision: queryPath.revision,
      });

      const invalidJson = await queryPath.run(dependenciesReturningSerialized('{invalid-json'));
      expect(invalidJson).toMatchObject(expectedQueryFailure(queryPath));

      for (const invalidPayload of [queryPath.wrongFingerprintPayload, queryPath.wrongRevisionPayload]) {
        const invalidResult = await queryPath.run(dependenciesReturning(invalidPayload));
        expect(invalidResult).toMatchObject(expectedQueryFailure(queryPath));
      }

      expect(tryGetWebProcessRuntime()).toBeUndefined();
    });
  }

  test('logs an expired sessions revision as a failed business boundary', async () => {
    const fixture = makeWebEventRuntimeFixture();

    try {
      const result = await runRevisionQueryForServer('sessions', sessionRequest, {
        execute: () => Promise.resolve({ message: 'Revision expired', ok: false }),
      });

      expect(result.ok).toBe(false);
      const sessionEvents = fixture.sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]?.outcome).toBe('failure');
      expect(sessionEvents[0]?.annotations.failureKind).toBe('revision-expired');
    } finally {
      await fixture.dispose();
    }
  });

  test('keeps sessions parsing inside the boundary so the protocol result and event agree', async () => {
    const fixture = makeWebEventRuntimeFixture();

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
      const sessionEvents = fixture.sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]?.outcome).toBe('failure');
      expect(sessionEvents[0]?.annotations.failureKind).toBe('query-failed');
      expect(sessionEvents[0]?.services.map(({ name }) => name)).toEqual(['revision.execute', 'revision.parse']);
    } finally {
      await fixture.dispose();
    }
  });

  test('records sessions execution phases and bounded result summaries on success', async () => {
    const fixture = makeWebEventRuntimeFixture();

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
      const event = fixture.sink.events().find(({ boundary }) => boundary === 'web.sessions.read');
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
      await fixture.dispose();
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
      const fixture = makeWebEventRuntimeFixture();
      try {
        const result = await runRevisionQueryForServer('sessions', sessionRequest, dependencies);
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.error.tag).toBe('QueryFailed');
        const events = fixture.sink.events().filter(({ boundary }) => boundary === 'web.sessions.read');
        expect(events).toHaveLength(1);
        expect(events[0]?.outcome).toBe('failure');
        expect(events[0]?.annotations.failureKind).toBe('query-failed');
      } finally {
        await fixture.dispose();
      }
    }
  });
});
