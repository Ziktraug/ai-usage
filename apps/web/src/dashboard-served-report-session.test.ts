import { expect, test } from 'bun:test';
import {
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedReportSupport,
  focusedOverviewFingerprint,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { createDashboardServedReportSession, type DashboardServedDestination } from './dashboard-served-report-session';
import {
  createFocusedReportStore,
  type FocusedReportBootstrapDescriptor,
  type FocusedReportSource,
  fetchFocusedReportBootstrapDescriptor,
} from './focused-report-client';
import { demoReportPayload } from './report-data';
import type { SessionQueryCoordinator } from './session-query-client';
import {
  parseReportRevision,
  reportManifestRequestFingerprint,
  type WebReportRevisionBootstrapResult,
} from './web-report-payload';

const revision = 'revision-a';

const reportSupport = (): FocusedReportSupport => {
  const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
  return support;
};

const bootstrapResult = (): WebReportRevisionBootstrapResult => ({
  bootstrap: projectFocusedSupport(
    reportSupport(),
    {
      harness: ['codex'],
      machine: [{ label: 'Fixture Machine', value: 'fixture-machine' }],
      truncated: false,
    },
    { revision },
  ),
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

const overviewResult = (request: FocusedOverviewRequest): FocusedOverviewResult =>
  projectFocusedOverview(demoReportPayload.rows, reportSupport(), request);

const success = <Result extends { requestFingerprint: string; revision: string }>(
  data: Result,
): SessionQueryServerResult<Result> => ({
  data,
  ok: true,
  requestFingerprint: data.requestFingerprint,
  revision: data.revision,
});

const unusedSessionCoordinator = (): SessionQueryCoordinator => ({
  canCommitPrepared: () => false,
  close: () => undefined,
  commitPrepared: () => undefined,
  loadCampaignChildren: () => Promise.reject(new Error('Unexpected campaign children request')),
  loadMore: () => Promise.reject(new Error('Unexpected session page request')),
  loadNeighbors: () => Promise.reject(new Error('Unexpected neighbor request')),
  prepare: () => Promise.reject(new Error('Unexpected session preparation')),
  select: () => undefined,
  start: () => Promise.reject(new Error('Unexpected session start')),
  state: () => undefined,
});

const initialDestination: DashboardServedDestination = {
  includeAdvanced: false,
  kind: 'overview',
  query: {
    filters: { fields: {}, harness: [], machine: [], query: '' },
    range: { from: null, to: null },
  },
  timeline: { dimension: 'harness', granularity: 'day' },
};

const createHydratedSession = (source: FocusedReportSource, descriptor: FocusedReportBootstrapDescriptor) =>
  createDashboardServedReportSession({
    focusedSource: source,
    focusedStore: createFocusedReportStore(descriptor.bootstrap),
    initialDescriptor: descriptor,
    sessionCoordinator: unusedSessionCoordinator(),
  });

test('reuses the server-rendered descriptor for the first hydrated destination', async () => {
  let bootstrapRequests = 0;
  const source: FocusedReportSource = {
    getBootstrap: () => {
      bootstrapRequests += 1;
      return Promise.resolve(bootstrapResult());
    },
    getBreakdown: (_request: FocusedBreakdownRequest) =>
      Promise.reject<SessionQueryServerResult<FocusedBreakdownResult>>(new Error('Unexpected breakdown request')),
    getOverview: (request) => Promise.resolve(success(overviewResult(request))),
  };
  const serverRenderedDescriptor = await fetchFocusedReportBootstrapDescriptor(source);
  const session = createHydratedSession(source, serverRenderedDescriptor);

  expect((await session.refresh(initialDestination)).status).toBe('committed');
  expect(bootstrapRequests).toBe(1);
});

test('acquires a fresh descriptor after the one-shot hydration seed is consumed', async () => {
  let bootstrapRequests = 0;
  const source: FocusedReportSource = {
    getBootstrap: () => {
      bootstrapRequests += 1;
      return Promise.resolve(bootstrapResult());
    },
    getBreakdown: (_request: FocusedBreakdownRequest) =>
      Promise.reject<SessionQueryServerResult<FocusedBreakdownResult>>(new Error('Unexpected breakdown request')),
    getOverview: (request) => Promise.resolve(success(overviewResult(request))),
  };
  const descriptor = await fetchFocusedReportBootstrapDescriptor(source);
  const session = createHydratedSession(source, descriptor);

  expect((await session.refresh(initialDestination)).status).toBe('committed');
  expect((await session.refresh(initialDestination)).status).toBe('no-change');
  expect(bootstrapRequests).toBe(2);
});

test('uses a fresh acquisition when a destination expires after the hydration seed', async () => {
  let bootstrapRequests = 0;
  let overviewRequests = 0;
  const source: FocusedReportSource = {
    getBootstrap: () => {
      bootstrapRequests += 1;
      return Promise.resolve(bootstrapResult());
    },
    getBreakdown: (_request: FocusedBreakdownRequest) =>
      Promise.reject<SessionQueryServerResult<FocusedBreakdownResult>>(new Error('Unexpected breakdown request')),
    getOverview: (request) => {
      overviewRequests += 1;
      if (overviewRequests === 1) {
        return Promise.resolve({
          error: { message: 'expired', revision: request.query.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      }
      return Promise.resolve(success(overviewResult(request)));
    },
  };
  const descriptor = await fetchFocusedReportBootstrapDescriptor(source);
  const session = createHydratedSession(source, descriptor);

  expect((await session.refresh(initialDestination)).status).toBe('committed');
  expect({ bootstrapRequests, overviewRequests }).toEqual({ bootstrapRequests: 2, overviewRequests: 2 });
});

test('keeps hydration seeds isolated per served report session instance', async () => {
  let bootstrapRequests = 0;
  const source: FocusedReportSource = {
    getBootstrap: () => {
      bootstrapRequests += 1;
      return Promise.resolve(bootstrapResult());
    },
    getBreakdown: (_request: FocusedBreakdownRequest) =>
      Promise.reject<SessionQueryServerResult<FocusedBreakdownResult>>(new Error('Unexpected breakdown request')),
    getOverview: (request) => Promise.resolve(success(overviewResult(request))),
  };
  const firstDescriptor = await fetchFocusedReportBootstrapDescriptor(source);
  const secondDescriptor = await fetchFocusedReportBootstrapDescriptor(source);
  const firstSession = createHydratedSession(source, firstDescriptor);
  const secondSession = createHydratedSession(source, secondDescriptor);

  expect((await firstSession.refresh(initialDestination)).status).toBe('committed');
  expect((await secondSession.refresh(initialDestination)).status).toBe('committed');
  expect(bootstrapRequests).toBe(2);
});
