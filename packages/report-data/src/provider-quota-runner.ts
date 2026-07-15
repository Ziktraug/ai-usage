#!/usr/bin/env bun
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { parseProviderQuotaHistoryRequest } from '@ai-usage/report-core/provider-quota';
import { Effect } from 'effect';
import { queryLocalProviderQuotaHistory, refreshLocalProviderQuotas } from './provider-quota';
import { writeReportPayloadArtifact } from './report-payload-artifact';

const operation = process.argv[2];
const serializedInput = process.argv[3];
const outputPath = process.argv[4];
if (!(serializedInput && outputPath && (operation === 'history' || operation === 'refresh'))) {
  throw new Error('Provider quota runner requires an operation, request, and output path');
}

const input: unknown = JSON.parse(serializedInput);
const result =
  operation === 'history'
    ? await Effect.runPromise(
        queryLocalProviderQuotaHistory(parseProviderQuotaHistoryRequest(input)).pipe(
          Effect.provide(LocalHistoryStorageLive),
        ),
      )
    : await Effect.runPromise(refreshLocalProviderQuotas().pipe(Effect.provide(LocalHistoryStorageLive)));
await writeReportPayloadArtifact(outputPath, JSON.stringify(result));
