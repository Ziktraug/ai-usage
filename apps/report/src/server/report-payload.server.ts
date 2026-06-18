import { createLocalReportPayload, runLocalReportPayload } from '@ai-usage/reporting';

const reportOptions = {
  since: null,
  project: null,
  limit: null,
  minTokens: 1,
  sort: 'date',
} as const;

const reportPayloadRequest = {
  harness: null,
  includeCursor: true,
  keepSource: true,
  options: reportOptions,
  includeFacets: true,
} as const;

export const collectReportPayload = createLocalReportPayload(reportPayloadRequest);

export const runReportPayloadCollection = () => runLocalReportPayload(reportPayloadRequest);
