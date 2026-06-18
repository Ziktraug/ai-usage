import path from 'node:path';
import { applyProjectAliases } from '@ai-usage/core/project-alias';
import {
  createUsageReportPayload,
  prepareUsageReport,
  type ReportOptions,
  type UsageReportPayload,
} from '@ai-usage/core/report-data';
import type { HarnessKey } from '@ai-usage/core/harness-metadata';
import type { Row } from '@ai-usage/core/types';
import {
  collectHarnessFacets,
  collectSelectedHarnessRows,
  type HarnessSelection,
} from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import { Effect } from 'effect';

export interface LocalReportRowsRequest {
  harness: HarnessKey | null;
  includeCursor: boolean;
  keepSource?: boolean;
  configCwd?: string;
}

export interface LocalReportPayloadRequest extends LocalReportRowsRequest {
  options: ReportOptions;
  includeFacets?: boolean;
  generatedAt?: Date;
}

const toHarnessSelection = (
  request: LocalReportRowsRequest,
  cursorCsv: HarnessSelection['cursorCsv'],
): HarnessSelection => ({
  harness: request.harness,
  includeCursor: request.includeCursor,
  ...(request.keepSource !== undefined ? { keepSource: request.keepSource } : {}),
  ...(cursorCsv ? { cursorCsv } : {}),
});

const resolveConfigPath = (configCwd: string | undefined, value: string) =>
  configCwd && !path.isAbsolute(value) ? path.resolve(configCwd, value) : value;

const resolveCursorConfig = (
  cursorCsv: HarnessSelection['cursorCsv'],
  configCwd: string | undefined,
): HarnessSelection['cursorCsv'] => {
  if (!cursorCsv) return undefined;
  return {
    ...cursorCsv,
    ...(cursorCsv.usageExportDir
      ? { usageExportDir: resolveConfigPath(configCwd, cursorCsv.usageExportDir) }
      : {}),
    ...(cursorCsv.usageExportPaths
      ? { usageExportPaths: cursorCsv.usageExportPaths.map((filePath) => resolveConfigPath(configCwd, filePath)) }
      : {}),
  };
};

export const collectLocalReportRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const collectedRows = yield* collectSelectedHarnessRows(
      toHarnessSelection(request, resolveCursorConfig(config.cursor, request.configCwd)),
    );
    return applyProjectAliases(collectedRows, config.projectAliases ?? []);
  });

export const createLocalReportPayload = (request: LocalReportPayloadRequest) =>
  Effect.gen(function* () {
    const rows: Row[] = yield* collectLocalReportRows(request);
    const facets = request.includeFacets
      ? yield* collectHarnessFacets({
          includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
        })
      : undefined;
    const report = prepareUsageReport(rows, request.options);
    return createUsageReportPayload(report, request.options, request.generatedAt ?? new Date(), facets);
  });

export const runLocalReportPayload = (request: LocalReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createLocalReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));
