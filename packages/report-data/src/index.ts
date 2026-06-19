import fs from 'node:fs';
import path from 'node:path';
import { applyProjectAliases } from '@ai-usage/report-core/project-alias';
import {
  createUsageReportPayload,
  type PreparedUsageReport,
  prepareUsageReport,
  type ReportOptions,
  type UsageReportPayload,
} from '@ai-usage/report-core/report-data';
import { harnessKeys, type HarnessKey } from '@ai-usage/report-core/harness-metadata';
import {
  createUsageSnapshot,
  mergeUsageSnapshots,
  type SnapshotMergeWarning,
  type UsageMachine,
  type UsageSnapshot,
} from '@ai-usage/report-core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import { usageRowTokenTotal } from '@ai-usage/report-core/usage-row';
import {
  collectHarnessFacets,
  collectSelectedHarnessResults,
  collectSelectedHarnessRows,
  type SelectedHarnessCollectionResult,
  type HarnessSelection,
} from '@ai-usage/local-collectors';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-collectors/errors';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import { importLocalRows, queryReportRows, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';

export interface LocalUsageSelection {
  harness: HarnessKey | null;
  includeCursor: boolean;
  configCwd?: string;
}

export interface LocalReportRowsRequest extends LocalUsageSelection {
  keepSource?: boolean;
}

export interface LocalReportPayloadRequest extends LocalReportRowsRequest {
  options: ReportOptions;
  includeFacets?: boolean;
  generatedAt?: Date;
}

export interface LocalReportRowsResult {
  rows: Row[];
  warnings: LocalHistoryWarning[];
  collection: SelectedHarnessCollectionResult;
}

export interface LocalUsageSnapshotRequest extends LocalUsageSelection {
  machine?: UsageMachine;
  generatedAt?: Date;
  appVersion?: string | null;
  includeFacets?: boolean;
}

export interface MergedUsageReportRequest extends LocalUsageSelection {
  snapshots: UsageSnapshot[];
  includeLocal?: boolean;
  machine?: UsageMachine;
  options: ReportOptions;
  generatedAt?: Date;
  appVersion?: string | null;
  includeFacets?: boolean;
}

export interface MergedUsageReport {
  rows: Row[];
  report: PreparedUsageReport;
  payload: UsageReportPayload;
  warnings: SnapshotMergeWarning[];
  duplicatesDropped: number;
}

export interface ProjectSource {
  project: string;
  machine: string;
  machineId: string;
  harness: string;
  harnessKey: string;
  sourcePath: string;
  gitRemote: string;
  sessions: number;
  tokens: number;
}

export interface ProjectSourcesResult {
  sources: ProjectSource[];
  warnings: SnapshotMergeWarning[];
}

export interface ProjectSourcesRequest extends LocalUsageSelection {
  snapshots: UsageSnapshot[];
  includeLocal?: boolean;
  machine?: UsageMachine;
  generatedAt?: Date;
  appVersion?: string | null;
  includeGitRemote?: boolean;
}

const toLocalUsageSnapshotRequest = (request: {
  harness: HarnessKey | null;
  includeCursor: boolean;
  configCwd?: string;
  machine?: UsageMachine;
  generatedAt?: Date;
  appVersion?: string | null;
}): LocalUsageSnapshotRequest => ({
  harness: request.harness,
  includeCursor: request.includeCursor,
  ...(request.configCwd !== undefined ? { configCwd: request.configCwd } : {}),
  ...(request.machine !== undefined ? { machine: request.machine } : {}),
  ...(request.generatedAt !== undefined ? { generatedAt: request.generatedAt } : {}),
  ...(request.appVersion !== undefined ? { appVersion: request.appVersion } : {}),
});

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

const collectConfiguredLocalRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const collectedRows = yield* collectSelectedHarnessRows(
      toHarnessSelection(request, resolveCursorConfig(config.cursor, request.configCwd)),
    );
    return { config, rows: collectedRows };
  });

const collectConfiguredLocalRowsWithWarnings = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const collection = yield* collectSelectedHarnessResults(
      toHarnessSelection(request, resolveCursorConfig(config.cursor, request.configCwd)),
    );
    return { config, collection };
  });

const usageStoreLocalHistoryError = (operation: string, dbPath: string) => (cause: unknown) =>
  new LocalHistoryError({ operation, path: dbPath, cause });

const selectedStoredHarnessKeys = (request: LocalUsageSelection): HarnessKey[] | undefined => {
  if (request.harness) return [request.harness];
  if (request.includeCursor) return undefined;
  return harnessKeys.filter((key) => key !== 'cursor');
};

export const collectLocalReportRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const { config, rows } = yield* collectConfiguredLocalRows(request);
    return applyProjectAliases(rows, config.projectAliases ?? []);
  });

export const collectLocalReportRowsWithWarnings = (request: LocalReportRowsRequest): Effect.Effect<
  LocalReportRowsResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const machine = yield* ensureMachineConfig;
    const dbPath = usageStorePath(storage.home);
    const { config, collection } = yield* collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true });
    const rows = applyProjectAliases(collection.rows, config.projectAliases ?? []);
    yield* importLocalRows({ dbPath, machine, rows }).pipe(
      Effect.mapError(usageStoreLocalHistoryError('usageStore.importLocalRows', dbPath)),
    );
    const harnessKeys = selectedStoredHarnessKeys(request);
    const stored = yield* queryReportRows({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
      Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)),
    );
    const harnesses = collection.harnesses.map((harness) => ({
      ...harness,
      rows: stored.rows.filter((row) => row.harness === harness.label),
    }));
    return { rows: stored.rows, warnings: collection.warnings, collection: { ...collection, rows: stored.rows, harnesses } };
  });

export const createLocalReportPayload = (request: LocalReportPayloadRequest) =>
  Effect.gen(function* () {
    const { rows, warnings } = yield* collectLocalReportRowsWithWarnings(request);
    const facets = request.includeFacets
      ? yield* collectHarnessFacets({
          includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
        })
      : undefined;
    const report = prepareUsageReport(rows, request.options);
    return createUsageReportPayload(report, request.options, request.generatedAt ?? new Date(), facets, warnings);
  });

export const createLocalUsageSnapshot = (request: LocalUsageSnapshotRequest) =>
  Effect.gen(function* () {
    const machine = request.machine ?? (yield* ensureMachineConfig);
    const { collection } = yield* collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true });
    const facets = request.includeFacets
      ? yield* collectHarnessFacets({
          includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
        })
      : undefined;

    return createUsageSnapshot({
      machine,
      rows: collection.rows,
      ...(request.generatedAt !== undefined ? { generatedAt: request.generatedAt } : {}),
      ...(request.appVersion !== undefined ? { appVersion: request.appVersion } : {}),
      ...(collection.warnings.length ? { warnings: collection.warnings } : {}),
      ...(facets !== undefined ? { facets } : {}),
    });
  });

export const createMergedUsageReport = (request: MergedUsageReportRequest) =>
  Effect.gen(function* () {
    const snapshots = [...request.snapshots];
    if (request.includeLocal) {
      snapshots.push(yield* createLocalUsageSnapshot(toLocalUsageSnapshotRequest(request)));
    }

    const merged = mergeUsageSnapshots(snapshots);
    const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
    const rows = applyProjectAliases(merged.rows, config.projectAliases ?? []);
    const report = prepareUsageReport(rows, request.options);
    const allWarnings = merged.warnings;
    const payloadWarnings = allWarnings.map(({ key, ...warning }) => ({
      ...warning,
      message: key ? `${warning.message}: ${key}` : warning.message,
    }));
    const facets = request.includeFacets
      ? yield* collectHarnessFacets({
          includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
        })
      : undefined;

    return {
      rows,
      report,
      payload: createUsageReportPayload(report, request.options, request.generatedAt ?? new Date(), facets, payloadWarnings),
      warnings: allWarnings,
      duplicatesDropped: merged.duplicatesDropped,
    };
  });

const projectFromRow = (row: SourcedRow) => row.project || path.basename(row.source.sourcePath ?? '') || '(unknown)';

const readGitRemoteUrl = (projectPath: string): string => {
  try {
    const configPath = path.join(projectPath, '.git', 'config');
    if (!fs.existsSync(configPath)) return '';
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/^\[remote\s+"origin"\]\s*\n\s*url\s*=\s*(.+)$/m);
    return match ? extractRepoName(match[1]!.trim()) : '';
  } catch {
    return '';
  }
};

const extractRepoName = (url: string): string => {
  const httpsMatch = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1]!;
  const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1]!;
  return url;
};

const collectProjectSources = (rows: SourcedRow[], includeGitRemote: boolean): ProjectSource[] => {
  const summaries = new Map<string, ProjectSource>();

  for (const row of rows) {
    const source = row.source;
    const summary: ProjectSource = {
      project: projectFromRow(row),
      machine: source.machineLabel ?? 'Unknown machine',
      machineId: source.machineId ?? '',
      harness: row.harness,
      harnessKey: source.harnessKey,
      sourcePath: source.sourcePath ?? '',
      gitRemote: '',
      sessions: 0,
      tokens: 0,
    };
    const key = [summary.project, summary.machineId, summary.machine, summary.harness, summary.sourcePath].join('|');
    const current = summaries.get(key) ?? summary;
    current.sessions++;
    current.tokens += usageRowTokenTotal(row);
    summaries.set(key, current);
  }

  const result = [...summaries.values()].sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.machine.localeCompare(b.machine) || a.harness.localeCompare(b.harness),
  );

  if (includeGitRemote) enrichGitRemotes(result);
  return result;
};

const enrichGitRemotes = (sources: ProjectSource[]) => {
  const cache = new Map<string, string>();
  for (const source of sources) {
    if (!source.sourcePath) continue;
    const cached = cache.get(source.sourcePath);
    if (cached !== undefined) {
      source.gitRemote = cached;
      continue;
    }
    const gitRemote = readGitRemoteUrl(source.sourcePath);
    cache.set(source.sourcePath, gitRemote);
    source.gitRemote = gitRemote;
  }
};

export const listProjectSourcesWithWarnings = (request: ProjectSourcesRequest): Effect.Effect<
  ProjectSourcesResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  Effect.gen(function* () {
    const snapshots = [...request.snapshots];
    if (request.includeLocal) {
      snapshots.push(yield* createLocalUsageSnapshot(toLocalUsageSnapshotRequest(request)));
    }

    const merged = mergeUsageSnapshots(snapshots);
    return {
      sources: collectProjectSources(merged.rows, request.includeGitRemote ?? false),
      warnings: merged.warnings,
    };
  });

export const listProjectSources = (request: ProjectSourcesRequest) =>
  listProjectSourcesWithWarnings(request).pipe(Effect.map((result) => result.sources));

export const runLocalReportPayload = (request: LocalReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createLocalReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));
