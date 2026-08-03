import { describe, expect, test } from 'bun:test';
import {
  type FocusedReportSupport,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  projectFocusedBreakdown,
  projectFocusedOverview,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import { createWebQueryClient } from '../../../query/client';
import type { ReportQueryClient } from '../../../query/options/report';
import {
  createFocusedReportDescriptorSource,
  createFocusedReportSession,
  initialFocusedReportDescriptor,
} from './report-destination';

const { rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;

const bootstrap = (revision: string): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => ({
  bootstrap: projectFocusedSupport(reportSupport, { harness: ['codex'], machine: [], truncated: false }, { revision }),
  manifest: {
    captureFingerprint: `${revision}-capture`,
    expiresAt: 2,
    generatedAt: reportSupport.generatedAt,
    publishedAt: 1,
    revision,
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: 'report-manifest:v1:{}',
});

describe('focused Svelte report destination', () => {
  test('reacquires once after expiry and atomically commits matching Overview and Breakdown results', async () => {
    const queryClient = createWebQueryClient();
    let bootstrapCalls = 0;
    let overviewCalls = 0;
    let breakdownCalls = 0;
    const client: ReportQueryClient = {
      getFocusedReportBreakdown: (request) => {
        breakdownCalls += 1;
        const data = projectFocusedBreakdown(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedBreakdownFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportOverview: (request) => {
        overviewCalls += 1;
        if (request.query.revision === 'revision-one') {
          return Promise.resolve({
            error: {
              message: 'expired',
              revision: request.query.revision,
              tag: 'RevisionExpired',
            },
            ok: false,
            requestFingerprint: focusedOverviewFingerprint(request),
            revision: request.query.revision,
          });
        }
        const data = projectFocusedOverview(rows, reportSupport as FocusedReportSupport, request);
        return Promise.resolve({
          data,
          ok: true,
          requestFingerprint: focusedOverviewFingerprint(request),
          revision: request.query.revision,
        });
      },
      getFocusedReportSupport: () => Promise.reject(new Error('Unexpected support query')),
      getReportRevisionBootstrap: () => {
        bootstrapCalls += 1;
        return Promise.resolve(bootstrap('revision-two'));
      },
      getReportRevisionManifest: () => Promise.reject(new Error('Unexpected manifest query')),
    };
    const descriptorSource = createFocusedReportDescriptorSource({
      client,
      initial: initialFocusedReportDescriptor(bootstrap('revision-one')),
      queryClient,
    });
    const commits: string[] = [];
    const session = createFocusedReportSession({
      acquire: descriptorSource.acquire,
      client,
      onCommit: ({ breakdown, overview }) => {
        expect(breakdown?.revision).toBe(overview.revision);
        commits.push(overview.revision);
      },
      queryClient,
    });

    const outcome = await session.refresh({
      kind: 'breakdown',
      query: {
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        range: { from: null, to: null },
      },
      timeline: { dimension: 'harness', granularity: 'day' },
    });

    expect(outcome.status).toBe('committed');
    expect(commits).toEqual(['revision-two']);
    expect(bootstrapCalls).toBe(1);
    expect(overviewCalls).toBe(2);
    expect(breakdownCalls).toBe(2);
    expect(descriptorSource.current().revision).toBe('revision-two');
  });
});
