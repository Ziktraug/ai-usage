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
import { Effect } from 'effect';
import {
  type RevisionQueryKind,
  type RevisionQueryRunnerDependencies,
  resolveRevisionQueryRunnerDependenciesForServer,
  runRevisionQueryForServer,
} from './revision-query-runner.server';

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
  execute: () => Promise.resolve({ ok: true, value }),
});

const sessionRequest: SessionQueryRequest = {
  cursor: null,
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
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

const makeWebEventDependencies = (dependencies: RevisionQueryRunnerDependencies) => {
  const sink = makeCaptureWideEventSink();
  const layer = makeTestWideEventSinkLayer(sink);
  return {
    dependencies: {
      ...dependencies,
      runEffect: <Value, _Failure>(effect: Parameters<NonNullable<RevisionQueryRunnerDependencies['runEffect']>>[0]) =>
        Effect.runPromise(effect.pipe(Effect.provide(layer))) as Promise<Value>,
    },
    sink,
  };
};

interface RevisionQueryParityPath {
  readonly fingerprint: string;
  readonly kind: RevisionQueryKind;
  readonly name: string;
  readonly request: unknown;
  readonly revision: string;
  readonly run: (dependencies: RevisionQueryRunnerDependencies) => Promise<SessionQueryServerResult<unknown>>;
  readonly successfulPayload: unknown;
  readonly wrongFingerprintPayload: unknown;
  readonly wrongRevisionPayload: unknown;
}

const revisionQueryParityPaths: readonly RevisionQueryParityPath[] = [
  {
    fingerprint,
    kind: 'session-detail-anchor',
    name: 'generic session detail',
    request,
    revision: request.revision,
    run: (dependencies) => runRevisionQueryForServer('session-detail-anchor', request, dependencies),
    successfulPayload: anchorResult,
    wrongFingerprintPayload: { ...anchorResult, requestFingerprint: 'session-detail-v2:wrong' },
    wrongRevisionPayload: { ...anchorResult, revision: 'revision-b' },
  },
  {
    fingerprint: sessionFingerprint,
    kind: 'sessions',
    name: 'observed sessions',
    request: sessionRequest,
    revision: sessionRequest.revision,
    run: (dependencies) => {
      const fixture = makeWebEventDependencies(dependencies);
      return runRevisionQueryForServer('sessions', sessionRequest, fixture.dependencies);
    },
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

describe('direct revision query server', () => {
  test('builds exact-revision dependencies from the mode-aware read-model resolver', async () => {
    let reads = 0;
    const dependencies = await resolveRevisionQueryRunnerDependenciesForServer(() =>
      Promise.resolve({
        queryRevision: ({ kind, revision }) => {
          reads += 1;
          expect({ kind, revision }).toEqual({ kind: 'session-detail-anchor', revision: 'revision-a' });
          return Promise.resolve(anchorResult);
        },
      }),
    );

    const result = await runRevisionQueryForServer('session-detail-anchor', request, dependencies);

    expect(result).toEqual({
      data: anchorResult,
      ok: true,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
    expect(reads).toBe(1);
  });

  for (const queryPath of revisionQueryParityPaths) {
    test(`${queryPath.name} preserves the exact revision query lifecycle`, async () => {
      const executions: unknown[] = [];
      const successful = await queryPath.run({
        execute: (execution) => {
          executions.push(execution);
          return Promise.resolve({ ok: true, value: queryPath.successfulPayload });
        },
      });

      expect(executions).toEqual([{ kind: queryPath.kind, request: queryPath.request, revision: queryPath.revision }]);
      expect(successful).toEqual({
        data: queryPath.successfulPayload,
        ok: true,
        requestFingerprint: queryPath.fingerprint,
        revision: queryPath.revision,
      });

      const expired = await queryPath.run({
        execute: () => Promise.resolve({ failure: 'revision-expired', ok: false }),
      });
      expect(expired).toEqual({
        error: {
          message: 'The requested report revision is unavailable.',
          revision: queryPath.revision,
          tag: 'RevisionExpired',
        },
        ok: false,
        requestFingerprint: queryPath.fingerprint,
        revision: queryPath.revision,
      });

      const failed = await queryPath.run({
        execute: () => Promise.resolve({ failure: 'query-failed', ok: false }),
      });
      expect(failed).toMatchObject(expectedQueryFailure(queryPath));

      const rejected = await queryPath.run({
        execute: () => Promise.reject(new Error('/private/database.sqlite: direct reader failed')),
      });
      expect(rejected).toMatchObject(expectedQueryFailure(queryPath));
      expect(JSON.stringify(rejected)).not.toContain('/private/database.sqlite');

      for (const invalidPayload of [queryPath.wrongFingerprintPayload, queryPath.wrongRevisionPayload, null]) {
        const invalidResult = await queryPath.run(dependenciesReturning(invalidPayload));
        expect(invalidResult).toMatchObject(expectedQueryFailure(queryPath));
      }
    });
  }

  test('keeps sessions execution, validation, and summaries inside one web boundary', async () => {
    const fixture = makeWebEventDependencies({
      execute: () => Promise.resolve({ diagnostics: { sqliteReadMs: 12 }, ok: true, value: emptySessionPage }),
    });

    const result = await runRevisionQueryForServer('sessions', sessionRequest, fixture.dependencies);

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
    expect(event?.services[0]?.annotations).toEqual({ sqliteReadMs: 12 });
  });

  test('classifies expiry and result validation failures without changing protocol identity', async () => {
    const cases: ReadonlyArray<{
      dependencies: RevisionQueryRunnerDependencies;
      failureKind: string;
      tag: string;
    }> = [
      {
        dependencies: {
          execute: () => Promise.resolve({ failure: 'revision-expired', ok: false }),
        },
        failureKind: 'revision-expired',
        tag: 'RevisionExpired',
      },
      {
        dependencies: dependenciesReturning({ ...emptySessionPage, revision: 'revision-b' }),
        failureKind: 'query-failed',
        tag: 'QueryFailed',
      },
    ];

    for (const testCase of cases) {
      const fixture = makeWebEventDependencies(testCase.dependencies);
      const result = await runRevisionQueryForServer('sessions', sessionRequest, fixture.dependencies);
      expect(result).toMatchObject({
        error: { revision: 'revision-a', tag: testCase.tag },
        ok: false,
        requestFingerprint: sessionFingerprint,
        revision: 'revision-a',
      });
      const event = fixture.sink.events().find(({ boundary }) => boundary === 'web.sessions.read');
      expect(event?.annotations.failureKind).toBe(testCase.failureKind);
    }
  });
});
