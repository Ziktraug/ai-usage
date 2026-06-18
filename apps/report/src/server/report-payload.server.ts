import { applyProjectAliases } from '@ai-usage/core/project-alias';
import { createUsageReportPayload, prepareUsageReport } from '@ai-usage/core/report-data';
import { collectHarnessFacets, collectSelectedHarnessRows } from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { readMergedAiUsageConfig } from '@ai-usage/local-collectors/machine-config';
import { Effect } from 'effect';

const reportOptions = {
  since: null,
  project: null,
  limit: null,
  minTokens: 1,
  sort: 'date',
} as const;

export const collectReportPayload = Effect.gen(function* () {
  const config = yield* readMergedAiUsageConfig;
  const collectedRows = yield* collectSelectedHarnessRows({
    harness: null,
    includeCursor: true,
    keepSource: true,
    ...(config.cursor ? { cursorCsv: config.cursor } : {}),
  });
  const rows = applyProjectAliases(collectedRows, config.projectAliases ?? []);
  const facets = yield* collectHarnessFacets({ includeCursor: true });
  const report = prepareUsageReport(rows, reportOptions);
  return createUsageReportPayload(report, reportOptions, new Date(), facets);
});

export const runReportPayloadCollection = () =>
  Effect.runPromise(collectReportPayload.pipe(Effect.provide(LocalHistoryStorageLive)));
