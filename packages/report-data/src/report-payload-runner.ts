#!/usr/bin/env bun
import {
  type LocalReportPayloadRequest,
  reportCaptureFingerprint,
  runConsistentStoredReportPayload,
  runLocalReportPayload,
} from './index';
import { writeReportPayloadArtifact } from './report-payload-artifact';

const mode = process.argv[2] === 'fresh' || process.argv[2] === 'stored' ? process.argv[2] : 'fresh';
const configCwd = process.argv[3] ?? process.argv[2] ?? process.cwd();
const currentCaptureFingerprint = process.argv[4] || undefined;
const outputPath = process.argv[5];

if (!outputPath) {
  throw new Error('The report payload runner requires a server-created output path');
}

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

const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);

const withStdoutRedirectedToStderr = async <A>(run: () => Promise<A>) => {
  process.stdout.write = writeStderr as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = writeStdout as typeof process.stdout.write;
  }
};

const payload = await withStdoutRedirectedToStderr(async () => {
  if (mode === 'fresh') {
    return await runLocalReportPayload(request);
  }
  return await runConsistentStoredReportPayload(request);
});

const captureFingerprint = reportCaptureFingerprint(payload);
const result =
  mode === 'fresh' && currentCaptureFingerprint === captureFingerprint
    ? { captureFingerprint, status: 'unchanged' as const, version: 1 as const }
    : { captureFingerprint, payload, status: 'changed' as const, version: 1 as const };
await writeReportPayloadArtifact(outputPath, JSON.stringify(result));
