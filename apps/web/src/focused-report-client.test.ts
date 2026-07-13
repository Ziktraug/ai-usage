import { describe, expect, test } from 'bun:test';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedCsvRequest,
  type FocusedCsvResult,
  type FocusedHtmlPayloadResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportSupport,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import { MAX_OVERVIEW_REFRESH_BYTES, MAX_SERVED_BOOTSTRAP_BYTES } from '@ai-usage/report-core/report-budgets';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import {
  createFocusedReportStore,
  type FocusedReportSource,
  fetchFocusedOverview,
  fetchFocusedReportBootstrap,
} from './focused-report-client';
import { demoReportPayload } from './report-data';
import {
  parseReportRevision,
  reportManifestRequestFingerprint,
  type WebReportRevisionManifestResult,
} from './web-report-payload';

const support = (): FocusedReportSupport => {
  const { rows: _rows, tableRows: _tableRows, ...value } = demoReportPayload;
  return value;
};

const revisionRequest = (revision = 'revision-a'): FocusedRevisionRequest => ({ revision });

const supportResult = (revision = 'revision-a'): FocusedSupportResult =>
  projectFocusedSupport(
    support(),
    { harness: ['codex'], machine: ['Fixture Machine'], truncated: false },
    revisionRequest(revision),
  );

const overviewRequest = (revision = 'revision-a'): FocusedOverviewRequest => ({
  includeAdvanced: false,
  query: {
    filters: { fields: {}, harness: [], machine: [], query: '' },
    range: { from: null, to: null },
    revision,
  },
  timeline: { dimension: 'harness', granularity: 'day' },
});

const overviewResult = (revision = 'revision-a'): FocusedOverviewResult =>
  projectFocusedOverview(demoReportPayload.rows, support(), overviewRequest(revision));

const manifest = (revision: string): WebReportRevisionManifestResult => ({
  manifest: {
    captureFingerprint: 'a'.repeat(64),
    expiresAt: 2,
    generatedAt: demoReportPayload.generatedAt,
    publishedAt: 1,
    revision: parseReportRevision(revision),
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: reportManifestRequestFingerprint,
});

const success = <Result extends { requestFingerprint: string; revision: string }>(
  data: Result,
): SessionQueryServerResult<Result> => ({
  data,
  ok: true,
  requestFingerprint: data.requestFingerprint,
  revision: data.revision,
});

const sourceWith = (overrides: Partial<FocusedReportSource>): FocusedReportSource => ({
  getBreakdown: (_request: FocusedBreakdownRequest) =>
    Promise.reject<SessionQueryServerResult<FocusedBreakdownResult>>(new Error('Unexpected breakdown request')),
  getCsv: (_request: FocusedCsvRequest) =>
    Promise.reject<SessionQueryServerResult<FocusedCsvResult>>(new Error('Unexpected CSV request')),
  getHtmlPayload: (_request: FocusedRevisionRequest) =>
    Promise.reject<SessionQueryServerResult<FocusedHtmlPayloadResult>>(new Error('Unexpected HTML request')),
  getManifest: () => Promise.resolve(manifest('revision-a')),
  getOverview: (_request: FocusedOverviewRequest) =>
    Promise.reject<SessionQueryServerResult<FocusedOverviewResult>>(new Error('Unexpected overview request')),
  getSupport: (request: FocusedRevisionRequest) => Promise.resolve(success(supportResult(request.revision))),
  ...overrides,
});

describe('focused report bootstrap and store', () => {
  test('keeps bootstrap and Overview fixture responses within frozen transfer budgets', () => {
    expect(Buffer.byteLength(JSON.stringify(supportResult()))).toBeLessThanOrEqual(MAX_SERVED_BOOTSTRAP_BYTES);
    expect(Buffer.byteLength(JSON.stringify(overviewResult()))).toBeLessThanOrEqual(MAX_OVERVIEW_REFRESH_BYTES);
  });

  test('performs one bounded query for each bootstrap and Overview request', async () => {
    let manifestRequests = 0;
    let supportRequests = 0;
    let overviewRequests = 0;
    const source = sourceWith({
      getManifest: () => {
        manifestRequests += 1;
        return Promise.resolve(manifest('revision-a'));
      },
      getOverview: (request) => {
        overviewRequests += 1;
        return Promise.resolve(success(overviewResult(request.query.revision)));
      },
      getSupport: (request) => {
        supportRequests += 1;
        return Promise.resolve(success(supportResult(request.revision)));
      },
    });

    await fetchFocusedReportBootstrap(source);
    await fetchFocusedOverview(source, overviewRequest());

    expect({ manifestRequests, overviewRequests, supportRequests }).toEqual({
      manifestRequests: 1,
      overviewRequests: 1,
      supportRequests: 1,
    });
  });

  test('applies focused results only at the current exact revision and fingerprint', () => {
    const store = createFocusedReportStore(supportResult());
    const request = overviewRequest();
    const result = overviewResult();

    expect(store.applyOverview(request, result)).toEqual({ applied: true });
    expect(store.overview()).toBe(result);
    expect(
      store.applyOverview(request, {
        ...result,
        requestFingerprint: 'focused-overview-v1:0000000000000000',
      }),
    ).toEqual({ applied: false, reason: 'fingerprint-mismatch' });
    expect(store.overview()).toBe(result);
  });

  test('does not publish the same Overview result twice', () => {
    const store = createFocusedReportStore(supportResult());
    const request = overviewRequest();
    const result = overviewResult();

    expect(store.applyOverview(request, result)).toEqual({ applied: true });
    const appliedSnapshot = store.snapshot();

    expect(store.applyOverview(request, result)).toEqual({ applied: true });
    expect(store.snapshot()).toBe(appliedSnapshot);
  });

  test('retains advanced analysis by query scope across timeline-only chart refreshes', () => {
    const store = createFocusedReportStore(supportResult());
    const advancedRequest = { ...overviewRequest(), includeAdvanced: true };
    const advancedResult = projectFocusedOverview(demoReportPayload.rows, support(), advancedRequest);
    expect(store.applyOverview(advancedRequest, advancedResult)).toEqual({ applied: true });
    expect(store.hasAdvancedAnalysis(advancedRequest.query)).toBe(true);

    const timelineRequest: FocusedOverviewRequest = {
      ...advancedRequest,
      includeAdvanced: false,
      timeline: { dimension: 'model', granularity: 'week' },
    };
    const timelineResult = projectFocusedOverview(demoReportPayload.rows, support(), timelineRequest);
    expect(store.applyOverview(timelineRequest, timelineResult)).toEqual({ applied: true });
    expect(store.overview()?.view.punchcard).toBeNull();
    expect(store.overviewForDisplay()?.view.punchcard).toEqual(advancedResult.view.punchcard);
    expect(store.overviewForDisplay()).not.toHaveProperty('requestFingerprint');

    const differentScopeRequest: FocusedOverviewRequest = {
      ...timelineRequest,
      query: { ...timelineRequest.query, range: { from: null, to: demoReportPayload.generatedAt } },
    };
    const differentScopeResult = projectFocusedOverview(demoReportPayload.rows, support(), differentScopeRequest);
    expect(store.applyOverview(differentScopeRequest, differentScopeResult)).toEqual({ applied: true });
    expect(store.hasAdvancedAnalysis(differentScopeRequest.query)).toBe(false);
    expect(store.overviewForDisplay()?.view.punchcard).toBeNull();
  });

  test('retains the active revision when a staged destination fails validation', () => {
    const store = createFocusedReportStore(supportResult());
    const activeOverview = overviewResult();
    store.applyOverview(overviewRequest(), activeOverview);

    expect(
      store.commitRevision(supportResult('revision-b'), {
        kind: 'overview',
        request: overviewRequest('revision-b'),
        result: {
          ...overviewResult('revision-b'),
          requestFingerprint: 'focused-overview-v1:0000000000000000',
        },
      }),
    ).toEqual({ applied: false, reason: 'fingerprint-mismatch' });
    expect(store.revision()).toBe('revision-a');
    expect(store.overview()).toBe(activeOverview);
  });

  test('commits bootstrap and its active destination without exposing a mixed revision', () => {
    const store = createFocusedReportStore(supportResult());
    store.applyOverview(overviewRequest(), overviewResult());
    expect(
      store.commitRevision(supportResult('revision-b'), {
        kind: 'overview',
        request: overviewRequest('revision-b'),
        result: overviewResult('revision-b'),
      }),
    ).toEqual({ applied: true });

    expect(store.revision()).toBe('revision-b');
    expect(store.overview()?.revision).toBe('revision-b');
    expect(store.snapshot()).toMatchObject({
      bootstrap: { revision: 'revision-b' },
      overview: { revision: 'revision-b' },
    });
    expect(store.support().generatedAt).toBe(demoReportPayload.generatedAt);
    expect(
      store.commitRevision(supportResult('revision-a'), {
        kind: 'overview',
        request: overviewRequest('revision-a'),
        result: overviewResult('revision-a'),
      }),
    ).toEqual({ applied: false, reason: 'superseded-revision' });
  });

  test('restarts bootstrap from a fresh manifest after exact-revision expiry', async () => {
    let manifestReads = 0;
    const requested: string[] = [];
    const bootstrap = await fetchFocusedReportBootstrap(
      sourceWith({
        getManifest: () => {
          manifestReads += 1;
          return Promise.resolve(manifest(manifestReads === 1 ? 'revision-a' : 'revision-b'));
        },
        getSupport: (request) => {
          requested.push(request.revision);
          if (request.revision === 'revision-a') {
            return Promise.resolve({
              error: { message: 'expired', revision: request.revision, tag: 'RevisionExpired' },
              ok: false,
              requestFingerprint: focusedRevisionFingerprint('support', request),
              revision: request.revision,
            });
          }
          return Promise.resolve(success(supportResult(request.revision)));
        },
      }),
    );

    expect(bootstrap.revision).toBe('revision-b');
    expect(requested).toEqual(['revision-a', 'revision-b']);
  });

  test('rejects wrong envelope fingerprints before applying parsed data', async () => {
    await expect(
      fetchFocusedReportBootstrap(
        sourceWith({
          getSupport: (request) =>
            Promise.resolve({
              ...success(supportResult(request.revision)),
              requestFingerprint: 'focused-support-v1:0000000000000000',
            }),
        }),
      ),
    ).rejects.toThrow('fingerprint mismatch');
  });

  test('uses the same canonical Overview fingerprint as the producer', () => {
    expect(overviewResult().requestFingerprint).toBe(focusedOverviewFingerprint(overviewRequest()));
  });
});
