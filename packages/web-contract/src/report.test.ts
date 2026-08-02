import { describe, expect, test } from 'bun:test';
import {
  type FocusedBreakdownRequest,
  type FocusedOverviewRequest,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
import { safeParse } from 'valibot';
import {
  parseFocusedBreakdownServerResult,
  parseFocusedOverviewServerResult,
  parseFocusedSupportServerResult,
  reportContract,
} from './report';

const query: FocusedOverviewRequest['query'] = {
  filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
  range: { from: null, to: null },
  revision: 'revision-a',
};

const overviewRequest: FocusedOverviewRequest = {
  includeAdvanced: false,
  query,
  timeline: { dimension: 'provider', granularity: 'day' },
};

const breakdownRequest: FocusedBreakdownRequest = { query };

describe('report contract', () => {
  test('declares the ten frozen operations with their exact methods', () => {
    expect({
      campaignLabelOverrides: reportContract.campaign.labelOverrides['~orpc'].route.method,
      campaignSetLabelOverride: reportContract.campaign.setLabelOverride['~orpc'].route.method,
      projectGroupSave: reportContract.projectGroup.save['~orpc'].route.method,
      quotaHistory: reportContract.quota.history['~orpc'].route.method,
      reportFocusedBreakdown: reportContract.report.focusedBreakdown['~orpc'].route.method,
      reportFocusedOverview: reportContract.report.focusedOverview['~orpc'].route.method,
      reportFocusedSupport: reportContract.report.focusedSupport['~orpc'].route.method,
      reportRevisionBootstrap: reportContract.report.revisionBootstrap['~orpc'].route.method,
      reportRevisionManifest: reportContract.report.revisionManifest['~orpc'].route.method,
      runtimeReportPerfEnabled: reportContract.runtime.reportPerfEnabled['~orpc'].route.method,
    }).toEqual({
      campaignLabelOverrides: 'GET',
      campaignSetLabelOverride: 'POST',
      projectGroupSave: 'POST',
      quotaHistory: 'POST',
      reportFocusedBreakdown: 'POST',
      reportFocusedOverview: 'POST',
      reportFocusedSupport: 'POST',
      reportRevisionBootstrap: 'GET',
      reportRevisionManifest: 'GET',
      runtimeReportPerfEnabled: 'GET',
    });
  });

  test('keeps operation-specific public error families closed', () => {
    expect(Object.keys(reportContract.report.focusedSupport['~orpc'].errorMap).sort()).toEqual([
      'ForbiddenDemo',
      'IncompatibleStore',
      'InvalidInput',
      'RevisionExpired',
    ]);
    expect(Object.keys(reportContract.campaign.setLabelOverride['~orpc'].errorMap).sort()).toEqual([
      'Conflict',
      'Forbidden',
      'ForbiddenDemo',
      'InvalidInput',
    ]);
    expect(Object.keys(reportContract.projectGroup.save['~orpc'].errorMap).sort()).toEqual([
      'Conflict',
      'EngineUnavailable',
      'Forbidden',
      'ForbiddenDemo',
      'InvalidInput',
    ]);
    const reportReadErrors = ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'];
    const focusedErrors = ['ForbiddenDemo', 'IncompatibleStore', 'InvalidInput', 'RevisionExpired'];
    expect(Object.keys(reportContract.report.revisionManifest['~orpc'].errorMap).sort()).toEqual(reportReadErrors);
    expect(Object.keys(reportContract.report.revisionBootstrap['~orpc'].errorMap).sort()).toEqual(reportReadErrors);
    expect(Object.keys(reportContract.report.focusedOverview['~orpc'].errorMap).sort()).toEqual(focusedErrors);
    expect(Object.keys(reportContract.report.focusedBreakdown['~orpc'].errorMap).sort()).toEqual(focusedErrors);
    expect(Object.keys(reportContract.campaign.labelOverrides['~orpc'].errorMap).sort()).toEqual([
      'ForbiddenDemo',
      'Unavailable',
    ]);
    expect(Object.keys(reportContract.quota.history['~orpc'].errorMap).sort()).toEqual([
      'ForbiddenDemo',
      'InvalidInput',
      'Unavailable',
    ]);
    expect(Object.keys(reportContract.runtime.reportPerfEnabled['~orpc'].errorMap)).toEqual(['ForbiddenDemo']);
  });

  test('normalizes campaign and quota inputs while rejecting unknown keys', () => {
    const campaignSchema = reportContract.campaign.setLabelOverride['~orpc'].inputSchema!;
    const campaign = safeParse(campaignSchema, { campaignKey: 'campaign-a', label: '  Alpha  ' });
    expect(campaign.success).toBe(true);
    if (campaign.success) {
      expect(campaign.output).toEqual({ campaignKey: 'campaign-a', label: 'Alpha' });
    }
    expect(
      safeParse(campaignSchema, { campaignKey: 'campaign-a', label: 'Alpha', privatePath: '/tmp/x' }).success,
    ).toBe(false);

    const quotaSchema = reportContract.quota.history['~orpc'].inputSchema!;
    const quota = safeParse(quotaSchema, {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });
    expect(quota.success).toBe(true);
    if (quota.success) {
      expect(quota.output.maximumPoints).toBe(1000);
    }
    expect(
      safeParse(quotaSchema, {
        from: '2026-08-01T00:00:00.000Z',
        privatePath: '/tmp/x',
        to: '2026-08-02T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('accepts only project source references, never file paths', () => {
    const schema = reportContract.projectGroup.save['~orpc'].inputSchema!;
    const source = `project-source:${'a'.repeat(64)}`;
    const input = {
      command: 'replace-project-groups-by-reference',
      projectGroups: [{ id: 'group-a', name: 'Group A', sources: [source] }],
      revision: 'publication-a',
    };
    expect(safeParse(schema, input).success).toBe(true);
    expect(
      safeParse(schema, {
        ...input,
        projectGroups: [{ id: 'group-a', name: 'Group A', sources: ['/private/history.jsonl'] }],
      }).success,
    ).toBe(false);
    expect(
      safeParse(schema, {
        ...input,
        projectGroups: [{ id: 'group-a', name: 'Group A', sources: [source, source] }],
      }).success,
    ).toBe(false);
  });

  test('binds focused results to the exact revision and request fingerprint', () => {
    const supportRequest = { revision: query.revision };
    const supportFailure = {
      error: { message: 'Revision expired.', revision: query.revision, tag: 'RevisionExpired' },
      ok: false,
      requestFingerprint: focusedRevisionFingerprint('support', supportRequest),
      revision: query.revision,
    } as const;
    expect(parseFocusedSupportServerResult(supportFailure, supportRequest)).toEqual(supportFailure);
    const longProtocolMessage = 'x'.repeat(513);
    expect(
      parseFocusedSupportServerResult(
        { ...supportFailure, error: { ...supportFailure.error, message: longProtocolMessage } },
        supportRequest,
      ),
    ).toEqual({ ...supportFailure, error: { ...supportFailure.error, message: longProtocolMessage } });
    expect(() =>
      parseFocusedSupportServerResult({ ...supportFailure, requestFingerprint: 'wrong' }, supportRequest),
    ).toThrow('identity');

    const overviewFailure = {
      error: { message: 'Query failed.', revision: query.revision, tag: 'QueryFailed' },
      ok: false,
      requestFingerprint: focusedOverviewFingerprint(overviewRequest),
      revision: query.revision,
    } as const;
    expect(parseFocusedOverviewServerResult(overviewFailure, overviewRequest)).toEqual(overviewFailure);
    expect(() =>
      parseFocusedOverviewServerResult({ ...overviewFailure, revision: 'revision-b' }, overviewRequest),
    ).toThrow();

    const breakdownFailure = {
      error: { message: 'Query failed.', revision: query.revision, tag: 'QueryFailed' },
      ok: false,
      requestFingerprint: focusedBreakdownFingerprint(breakdownRequest),
      revision: query.revision,
    } as const;
    expect(parseFocusedBreakdownServerResult(breakdownFailure, breakdownRequest)).toEqual(breakdownFailure);
    expect(() => parseFocusedBreakdownServerResult({ ...breakdownFailure, extra: true }, breakdownRequest)).toThrow(
      'focused report result',
    );
  });

  test('rejects non-JSON and accessor output values without reading accessors', () => {
    const outputSchema = reportContract.campaign.labelOverrides['~orpc'].outputSchema!;
    let reads = 0;
    const accessor = Object.defineProperty({}, 'campaignKey', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'secret';
      },
    });

    expect(safeParse(outputSchema, { campaignLabelOverrides: [accessor] }).success).toBe(false);
    expect(safeParse(outputSchema, { campaignLabelOverrides: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(safeParse(outputSchema, { campaignLabelOverrides: [new Blob(['private'])] }).success).toBe(false);
    expect(reads).toBe(0);
  });

  test('keeps no-input procedures closed and validates revision manifests', () => {
    expect(safeParse(reportContract.report.revisionManifest['~orpc'].inputSchema!, {}).success).toBe(true);
    expect(safeParse(reportContract.report.revisionManifest['~orpc'].inputSchema!, { ignored: true }).success).toBe(
      false,
    );
    expect(
      safeParse(reportContract.report.revisionManifest['~orpc'].outputSchema!, {
        manifest: {
          captureFingerprint: 'capture-a',
          expiresAt: 2,
          generatedAt: '2026-08-01T00:00:00.000Z',
          publishedAt: 1,
          revision: 'revision-a',
          rowsBytes: 10,
          supportBytes: 20,
        },
        ok: true,
        requestFingerprint: 'report-manifest:v1:{}',
      }).success,
    ).toBe(true);
  });
});
