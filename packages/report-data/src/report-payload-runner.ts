#!/usr/bin/env bun
import { type LocalReportPayloadRequest, runLocalReportPayload, runStoredReportPayload } from './index';

const mode = process.argv[2] === 'fresh' || process.argv[2] === 'stored' ? process.argv[2] : 'fresh';
const configCwd = process.argv[3] ?? process.argv[2] ?? process.cwd();

const request: LocalReportPayloadRequest = {
  harness: null,
  includeCursor: true,
  keepSource: true,
  configCwd,
  includeFacets: true,
  options: {
    since: null,
    project: null,
    limit: null,
    minTokens: 1,
    sort: 'date',
  },
};

const payload = await (mode === 'stored' ? runStoredReportPayload(request) : runLocalReportPayload(request));

process.stdout.write(JSON.stringify(payload));
