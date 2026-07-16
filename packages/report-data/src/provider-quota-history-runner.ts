#!/usr/bin/env bun
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import { queryLocalProviderQuotaHistory } from './provider-quota';
import { writeReportPayloadArtifact } from './report-payload-artifact';

const serializedInput = process.argv[2];
const outputPath = process.argv[3];
if (!(serializedInput && outputPath)) {
  throw new Error('Provider quota history runner requires a request and output path');
}

const input: unknown = JSON.parse(serializedInput);
const result = await Effect.runPromise(
  queryLocalProviderQuotaHistory(parseProviderQuotaHistoryRequest(input)).pipe(Effect.provide(LocalHistoryStorageLive)),
);
await writeReportPayloadArtifact(outputPath, JSON.stringify(result));
