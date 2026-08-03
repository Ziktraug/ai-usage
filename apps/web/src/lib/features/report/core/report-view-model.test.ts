import { describe, expect, it } from 'bun:test';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import { demoReportPayload } from '../../../../report-data';
import { toWebReportPayload } from '../../../../web-report-payload';
import { liveReportShellModel, reportGeneratedLabel, syntheticReportShellModel } from './report-view-model';

const support = () => {
  const { rows: _rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  return projectFocusedSupport(
    reportSupport,
    { harness: [], machine: [], truncated: false },
    { revision: 'revision-a' },
  );
};

describe('report SSR view model', () => {
  it('projects a bounded live bootstrap into meaningful initial report content', () => {
    const bootstrap = support();
    const model = liveReportShellModel({
      bootstrap,
      manifest: {
        captureFingerprint: 'c'.repeat(64),
        expiresAt: 2,
        generatedAt: '2026-08-01T10:00:00.000Z',
        publishedAt: 1,
        revision: 'revision-a',
        rowsBytes: 1,
        supportBytes: 1,
      },
      ok: true,
      requestFingerprint: 'report-manifest:v1:{}',
    });

    expect(model).toMatchObject({
      hasReportData: true,
      isDemo: false,
      publicationLabel: 'Compatible stored publication',
      revision: 'revision-a',
    });
    expect(model.overviewItems).toEqual(expect.arrayContaining([{ label: 'Harnesses', value: '0' }]));
    expect(reportGeneratedLabel('2026-08-01T10:00:00', model.hasReportData)).toBe('Generated Aug 01, 10:00');
  });

  it('keeps demo and E2E payloads meaningful without labelling E2E as demo', () => {
    const payload = toWebReportPayload(demoReportPayload);
    expect(syntheticReportShellModel('demo', payload)).toMatchObject({
      hasReportData: true,
      isDemo: true,
      publicationLabel: 'Synthetic demo publication',
    });
    expect(syntheticReportShellModel('e2e', payload)).toMatchObject({
      hasReportData: true,
      isDemo: false,
      publicationLabel: 'Synthetic test publication',
    });
  });

  it('uses the established unavailable copy when no complete report exists', () => {
    const unavailable = liveReportShellModel(undefined);
    const warnings: readonly unknown[] = unavailable.warnings;
    expect(unavailable.hasReportData).toBe(false);
    expect(warnings).toEqual([]);
    expect(reportGeneratedLabel(null, false)).toBe('Report payload unavailable');
  });
});
