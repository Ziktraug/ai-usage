import { describe, expect, test } from 'bun:test';
import {
  type FocusedBreakdownRequest,
  type FocusedOverviewRequest,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import { call } from '@orpc/server';
import { createReportRpcRouter, ReportRpcServiceError, type ReportRpcServices } from './report';

const revision = 'revision-a';
const query = {
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  range: { from: null, to: null },
  revision,
};
const overviewInput: FocusedOverviewRequest = {
  includeAdvanced: false,
  query,
  timeline: { dimension: 'provider', granularity: 'day' },
};
const breakdownInput: FocusedBreakdownRequest = { query };
const quotaInput = {
  from: '2026-08-01T00:00:00.000Z',
  maximumPoints: 1000,
  to: '2026-08-02T00:00:00.000Z',
} as const;

const reportManifest = {
  manifest: {
    captureFingerprint: 'capture-a',
    expiresAt: 2,
    generatedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: 1,
    revision,
    rowsBytes: 10,
    supportBytes: 20,
  },
  ok: true,
  requestFingerprint: 'report-manifest:v1:{}',
} as const;

const bootstrapUnavailable = {
  error: { message: 'Revision unavailable.', tag: 'RevisionUnavailable' },
  ok: false,
  requestFingerprint: 'report-manifest:v1:{}',
} as const;

const quotaResult = {
  coverage: [],
  generatedAt: '2026-08-02T00:00:00.000Z',
  latest: [],
  points: [],
  skipped: 0,
  truncated: false,
};

const focusedFailure = (requestFingerprint: string) =>
  ({
    error: { message: 'Query failed.', revision, tag: 'QueryFailed' },
    ok: false,
    requestFingerprint,
    revision,
  }) as const;

const createServices = (
  seen: Array<{ operation: string; signal: AbortSignal | undefined }> = [],
): ReportRpcServices => ({
  getCampaignLabelOverrides: ({ signal }) => {
    seen.push({ operation: 'campaign.labelOverrides', signal });
    return Promise.resolve({ campaignLabelOverrides: [] });
  },
  getProviderQuotaHistory: (_input, { signal }) => {
    seen.push({ operation: 'quota.history', signal });
    return Promise.resolve(quotaResult);
  },
  getReportPerfEnabled: ({ signal }) => {
    seen.push({ operation: 'runtime.reportPerfEnabled', signal });
    return Promise.resolve(true);
  },
  getReportRevisionBootstrap: ({ signal }) => {
    seen.push({ operation: 'report.revisionBootstrap', signal });
    return Promise.resolve(bootstrapUnavailable);
  },
  getReportRevisionManifest: ({ signal }) => {
    seen.push({ operation: 'report.revisionManifest', signal });
    return Promise.resolve(reportManifest);
  },
  runFocusedBreakdown: (_input, { signal }) => {
    seen.push({ operation: 'report.focusedBreakdown', signal });
    return Promise.resolve(focusedFailure(focusedBreakdownFingerprint(breakdownInput)));
  },
  runFocusedOverview: (_input, { signal }) => {
    seen.push({ operation: 'report.focusedOverview', signal });
    return Promise.resolve(focusedFailure(focusedOverviewFingerprint(overviewInput)));
  },
  runFocusedSupport: (input, { signal }) => {
    seen.push({ operation: 'report.focusedSupport', signal });
    return Promise.resolve(focusedFailure(focusedRevisionFingerprint('support', input)));
  },
  saveProjectGroups: (_input, { signal }) => {
    seen.push({ operation: 'projectGroup.save', signal });
    return Promise.resolve({ accepted: true as const });
  },
  setCampaignLabelOverride: (_input, { signal }) => {
    seen.push({ operation: 'campaign.setLabelOverride', signal });
    return Promise.resolve({ campaignLabelOverrides: [{ campaignKey: 'campaign-a', label: 'Alpha' }] });
  },
});

const publicErrorData = (error: unknown): unknown => {
  if (!(typeof error === 'object' && error !== null && 'data' in error)) {
    throw new Error('Expected public error data.');
  }
  return error.data;
};

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the procedure to reject.');
};

describe('report RPC handler', () => {
  test('dispatches all ten operations through injected services and forwards the request signal', async () => {
    const seen: Array<{ operation: string; signal: AbortSignal | undefined }> = [];
    const router = createReportRpcRouter(createServices(seen));
    const signal = new AbortController().signal;

    await call(router.campaign.labelOverrides, {}, { signal });
    await call(router.campaign.setLabelOverride, { campaignKey: 'campaign-a', label: 'Alpha' }, { signal });
    await call(
      router.projectGroup.save,
      {
        command: 'replace-project-groups-by-reference',
        projectGroups: [
          {
            id: 'group-a',
            name: 'Group A',
            sources: [`project-source:${'a'.repeat(64)}`],
          },
        ],
        revision: 'publication-a',
      },
      { signal },
    );
    await call(router.quota.history, quotaInput, { signal });
    await call(router.report.focusedBreakdown, breakdownInput, { signal });
    await call(router.report.focusedOverview, overviewInput, { signal });
    await call(router.report.focusedSupport, { revision }, { signal });
    await call(router.report.revisionBootstrap, {}, { signal });
    await call(router.report.revisionManifest, {}, { signal });
    await call(router.runtime.reportPerfEnabled, {}, { signal });

    expect(seen.map(({ operation }) => operation)).toEqual([
      'campaign.labelOverrides',
      'campaign.setLabelOverride',
      'projectGroup.save',
      'quota.history',
      'report.focusedBreakdown',
      'report.focusedOverview',
      'report.focusedSupport',
      'report.revisionBootstrap',
      'report.revisionManifest',
      'runtime.reportPerfEnabled',
    ]);
    expect(seen.every((entry) => entry.signal === signal)).toBe(true);
  });

  test('rejects a focused response whose identity does not match its request', async () => {
    const services = createServices();
    const router = createReportRpcRouter({
      ...services,
      runFocusedSupport: () => Promise.resolve(focusedFailure('wrong-fingerprint')),
    });

    const error = await caught(call(router.report.focusedSupport, { revision }));

    expect(error).toMatchObject({
      code: 'IncompatibleStore',
      data: {},
      message: 'The requested report support data is unavailable.',
    });
  });

  test('maps explicit service failures to typed public errors', async () => {
    const services = createServices();
    const router = createReportRpcRouter({
      ...services,
      getReportRevisionManifest: () => {
        throw new ReportRpcServiceError('Unavailable', 'Revision cache is warming.', 'warming');
      },
    });

    const error = await caught(call(router.report.revisionManifest, {}));

    expect(error).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'warming' },
      message: 'Revision cache is warming.',
    });
  });

  test('filters service reasons through the public error schema', async () => {
    const errorForReason = async (reason: string): Promise<unknown> => {
      const router = createReportRpcRouter({
        ...createServices(),
        getReportRevisionManifest: () => {
          throw new ReportRpcServiceError('Unavailable', 'Revision cache is unavailable.', reason);
        },
      });
      return await caught(call(router.report.revisionManifest, {}));
    };

    const validError = await errorForReason('schema-too-new');
    expect(validError).toMatchObject({ code: 'Unavailable' });
    expect(publicErrorData(validError)).toEqual({ reason: 'schema-too-new' });
    for (const invalidReason of ['schema.too-new', '0bad']) {
      const invalidError = await errorForReason(invalidReason);
      expect(invalidError).toMatchObject({ code: 'Unavailable' });
      expect(publicErrorData(invalidError)).toEqual({});
    }
  });

  test('preserves the exact cancellation reason before and after service awaits', async () => {
    const preAwaitReason = new Error('cancelled before service acquisition');
    const preAwaitController = new AbortController();
    preAwaitController.abort(preAwaitReason);
    let serviceCalls = 0;
    const preAwaitRouter = createReportRpcRouter({
      ...createServices(),
      getReportRevisionManifest: () => {
        serviceCalls += 1;
        return Promise.resolve(reportManifest);
      },
    });

    const preAwaitError = await caught(
      call(preAwaitRouter.report.revisionManifest, {}, { signal: preAwaitController.signal }),
    );
    expect(preAwaitError).toBe(preAwaitReason);
    expect(serviceCalls).toBe(0);

    let markServiceEntered: (() => void) | undefined;
    const serviceEntered = new Promise<void>((resolve) => {
      markServiceEntered = resolve;
    });
    let releaseService: ((value: typeof reportManifest) => void) | undefined;
    const serviceResult = new Promise<typeof reportManifest>((resolve) => {
      releaseService = resolve;
    });
    const postAwaitController = new AbortController();
    const postAwaitRouter = createReportRpcRouter({
      ...createServices(),
      getReportRevisionManifest: () => {
        markServiceEntered?.();
        return serviceResult;
      },
    });
    const request = call(postAwaitRouter.report.revisionManifest, {}, { signal: postAwaitController.signal });
    await serviceEntered;
    const postAwaitReason = new Error('cancelled during service await');
    postAwaitController.abort(postAwaitReason);
    releaseService?.(reportManifest);

    expect(await caught(request)).toBe(postAwaitReason);
  });

  test('normalizes a non-Error cancellation reason', async () => {
    const controller = new AbortController();
    const reason = { operation: 'report.revisionManifest', reason: 'superseded' };
    controller.abort(reason);
    const router = createReportRpcRouter(createServices());

    const error = await caught(call(router.report.revisionManifest, {}, { signal: controller.signal }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ cause: reason, message: 'The report operation was cancelled.' });
  });

  test('never exposes raw unknown service failures', async () => {
    const services = createServices();
    const router = createReportRpcRouter({
      ...services,
      getCampaignLabelOverrides: () => {
        throw new Error('read failed at /private/history.jsonl');
      },
    });

    const error = await caught(call(router.campaign.labelOverrides, {}));
    expect(error).toMatchObject({
      code: 'Unavailable',
      data: {},
      message: 'Campaign labels are temporarily unavailable.',
    });
    expect(JSON.stringify(error)).not.toContain('/private/history.jsonl');
  });
});
