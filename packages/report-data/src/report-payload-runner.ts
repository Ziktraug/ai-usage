#!/usr/bin/env bun
import { runLocalReportPayload } from './index';

const configCwd = process.argv[2] ?? process.cwd();

const payload = await runLocalReportPayload({
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
});

process.stdout.write(JSON.stringify(payload));
