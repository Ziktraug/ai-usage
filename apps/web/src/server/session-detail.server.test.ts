import { describe, expect, test } from 'bun:test';
import type {
  LocalSessionAnalysis,
  SessionDetail,
  SessionDetailReportAnchor,
  SessionProjectionFacts,
} from '@ai-usage/report-core/session-detail';
import { sessionDetailRequestFingerprint } from '@ai-usage/report-core/session-detail';
import type { SessionDetailServerDependencies } from './session-detail.server';
import { getLocalSessionDetailForServer } from './session-detail.server';

const request = { revision: 'revision-a', rowId: 'row-a' };
const tokens = { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 };
const projection: SessionProjectionFacts = {
  calls: 1,
  durationMs: 60_000,
  modelSegments: [{ model: 'gpt-5.6-sol', tokens }],
  partial: false,
  tokens,
  tools: 0,
  turns: 1,
};
const detail: SessionDetail = {
  activeDurationMs: 60_000,
  durationStatus: 'recorded',
  efforts: ['high'],
  elapsedDurationMs: 60_000,
  endedAt: '2026-07-18T10:01:00.000Z',
  idleDurationMs: 0,
  models: ['gpt-5.6-sol'],
  observedAt: '2026-07-18T10:01:01.000Z',
  phases: [],
  prompts: [],
  promptsTruncated: false,
  sourceSessionId: 'session-a',
  startedAt: '2026-07-18T10:00:00.000Z',
  turns: [],
  turnsStatus: 'recorded',
};
const anchor: SessionDetailReportAnchor = {
  harnessKey: 'codex',
  machineId: 'machine-a',
  projection,
  sourceSessionId: 'session-a',
};
const analysis: LocalSessionAnalysis = { detail, projection };

const dependencies = (overrides: Partial<SessionDetailServerDependencies> = {}): SessionDetailServerDependencies => ({
  readAnalysis: () => Promise.resolve(analysis),
  readMachine: () => Promise.resolve({ id: 'machine-a' }),
  resolveAnchor: () =>
    Promise.resolve({
      data: {
        anchor,
        requestFingerprint: sessionDetailRequestFingerprint(request),
        revision: request.revision,
      },
      ok: true,
      requestFingerprint: sessionDetailRequestFingerprint(request),
      revision: request.revision,
    }),
  ...overrides,
});

describe('local session detail server', () => {
  test('returns matching, differing, and incomparable projections', async () => {
    expect(await getLocalSessionDetailForServer(request, dependencies())).toMatchObject({
      consistency: { status: 'matches-report' },
      detail,
      revision: 'revision-a',
      status: 'available',
    });
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({ readAnalysis: () => Promise.resolve({ detail, projection: { ...projection, turns: 2 } }) }),
      ),
    ).toMatchObject({ consistency: { differingFields: ['turns'], status: 'differs-from-report' } });
    const unavailableProjection = { ...projection, modelSegments: null, tokens: null };
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({
          readAnalysis: () => Promise.resolve({ detail, projection: unavailableProjection }),
          resolveAnchor: () =>
            Promise.resolve({
              data: {
                anchor: { ...anchor, projection: unavailableProjection },
                requestFingerprint: sessionDetailRequestFingerprint(request),
                revision: request.revision,
              },
              ok: true,
              requestFingerprint: sessionDetailRequestFingerprint(request),
              revision: request.revision,
            }),
        }),
      ),
    ).toMatchObject({ consistency: { status: 'cannot-compare' } });
  });

  test('maps revision expiry and row/provenance failures before local reads', async () => {
    let localReads = 0;
    const noLocalReads = {
      readAnalysis: () => {
        localReads += 1;
        return Promise.resolve(analysis);
      },
      readMachine: () => {
        localReads += 1;
        return Promise.resolve({ id: 'machine-a' });
      },
    };
    const expired = dependencies({
      ...noLocalReads,
      resolveAnchor: () =>
        Promise.resolve({
          error: { message: 'gone', revision: request.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: sessionDetailRequestFingerprint(request),
          revision: request.revision,
        }),
    });
    expect(await getLocalSessionDetailForServer(request, expired)).toMatchObject({
      reason: 'revision-expired',
      status: 'unavailable',
    });
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({
          ...noLocalReads,
          resolveAnchor: () =>
            Promise.resolve({
              error: { message: '/private/database', revision: request.revision, tag: 'QueryFailed' },
              ok: false,
              requestFingerprint: sessionDetailRequestFingerprint(request),
              revision: request.revision,
            }),
        }),
      ),
    ).toEqual({
      message: 'The report row could not be read safely.',
      reason: 'history-unavailable',
      status: 'unavailable',
    });
    for (const expected of [
      { anchor: null, reason: 'report-row-not-found' },
      { anchor: { ...anchor, sourceSessionId: null }, reason: 'report-provenance-unavailable' },
    ] as const) {
      expect(
        await getLocalSessionDetailForServer(
          request,
          dependencies({
            ...noLocalReads,
            resolveAnchor: () =>
              Promise.resolve({
                data: {
                  anchor: expected.anchor,
                  requestFingerprint: sessionDetailRequestFingerprint(request),
                  revision: request.revision,
                },
                ok: true,
                requestFingerprint: sessionDetailRequestFingerprint(request),
                revision: request.revision,
              }),
          }),
        ),
      ).toMatchObject({ reason: expected.reason, status: 'unavailable' });
    }
    expect(localReads).toBe(0);
  });

  test('maps unsupported and non-local anchors without reading analysis', async () => {
    let reads = 0;
    const readAnalysis = () => {
      reads += 1;
      return Promise.resolve(analysis);
    };
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({
          readAnalysis,
          resolveAnchor: async () => {
            const result = await dependencies().resolveAnchor(request);
            if (!result.ok) {
              return result;
            }
            return { ...result, data: { ...result.data, anchor: { ...anchor, harnessKey: 'claude' } } };
          },
        }),
      ),
    ).toMatchObject({ reason: 'unsupported' });
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({ readAnalysis, readMachine: () => Promise.resolve({ id: 'machine-b' }) }),
      ),
    ).toMatchObject({ reason: 'not-local' });
    expect(reads).toBe(0);
  });

  test('maps missing and failed local history without exposing errors', async () => {
    expect(
      await getLocalSessionDetailForServer(request, dependencies({ readAnalysis: () => Promise.resolve(null) })),
    ).toMatchObject({ reason: 'not-found', status: 'unavailable' });
    expect(
      await getLocalSessionDetailForServer(
        request,
        dependencies({ readAnalysis: () => Promise.reject(new Error('/private/path must not escape')) }),
      ),
    ).toEqual({
      message: 'The local Codex history could not be read safely.',
      reason: 'history-unavailable',
      status: 'unavailable',
    });
  });
});
