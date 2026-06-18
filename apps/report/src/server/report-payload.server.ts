import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalReportPayload, runLocalReportPayload } from '@ai-usage/reporting';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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
  configCwd: rootDir,
  options: reportOptions,
  includeFacets: true,
} as const;

export const collectReportPayload = createLocalReportPayload(reportPayloadRequest);

export const runReportPayloadCollection = () => runLocalReportPayload(reportPayloadRequest);
