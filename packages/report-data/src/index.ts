import fs from 'node:fs';
import path from 'node:path';
import {
  collectHarnessFacets,
  collectSelectedHarnessResults,
  collectSelectedHarnessRows,
  type HarnessSelection,
  type SelectedHarnessCollectionResult,
} from '@ai-usage/local-collectors';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-collectors/errors';
import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import { type HarnessKey, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import { applyProjectAliases } from '@ai-usage/report-core/project-alias';
import {
  createUsageReportPayload,
  type PreparedUsageReport,
  prepareUsageReport,
  type ReportOptions,
  type UsageReportPayload,
} from '@ai-usage/report-core/report-data';
import {
  createUsageSnapshot,
  mergeUsageSnapshots,
  type SnapshotMergeWarning,
  type UsageMachine,
  type UsageSnapshot,
} from '@ai-usage/report-core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import { usageRowTokenTotal } from '@ai-usage/report-core/usage-row';
import { importLocalRows, queryReportRows, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { withPerfSpan } from './perf';

const GIT_CONFIG_LINE_SEPARATOR = /\r?\n/;
const GIT_REMOTE_HEADER_PATTERN = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const GIT_SECTION_HEADER_PATTERN = /^\s*\[[^\]]+\]\s*$/;
const GIT_REMOTE_URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/;
const GITHUB_HTTPS_REPO_PATTERN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;
const GITHUB_SSH_REPO_PATTERN = /git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/;

export interface LocalUsageSelection {
  configCwd?: string;
  harness: HarnessKey | null;
  includeCursor: boolean;
}

export interface LocalReportRowsRequest extends LocalUsageSelection {
  keepSource?: boolean;
}

export interface LocalReportPayloadRequest extends LocalReportRowsRequest {
  generatedAt?: Date;
  includeFacets?: boolean;
  options: ReportOptions;
}

export interface StoredReportPayloadRequest extends LocalUsageSelection {
  generatedAt?: Date;
  includeFacets?: boolean;
  options: ReportOptions;
}

export interface LocalReportRowsResult {
  collection: SelectedHarnessCollectionResult;
  rows: Row[];
  warnings: LocalHistoryWarning[];
}

export interface LocalUsageSnapshotRequest extends LocalUsageSelection {
  appVersion?: string | null;
  generatedAt?: Date;
  includeFacets?: boolean;
  machine?: UsageMachine;
}

export interface MergedUsageReportRequest extends LocalUsageSelection {
  appVersion?: string | null;
  generatedAt?: Date;
  includeFacets?: boolean;
  includeLocal?: boolean;
  machine?: UsageMachine;
  options: ReportOptions;
  snapshots: UsageSnapshot[];
}

export interface MergedUsageReport {
  duplicatesDropped: number;
  payload: UsageReportPayload;
  report: PreparedUsageReport;
  rows: Row[];
  warnings: SnapshotMergeWarning[];
}

export interface ProjectSource {
  gitRemote: string;
  harness: string;
  harnessKey: string;
  machine: string;
  machineId: string;
  project: string;
  sessions: number;
  sourcePath: string;
  tokens: number;
}

export interface ProjectSourcesResult {
  sources: ProjectSource[];
  warnings: SnapshotMergeWarning[];
}

export type ReadGitFile = (filePath: string) => string | null;

export interface ProjectSourcesRequest extends LocalUsageSelection {
  appVersion?: string | null;
  generatedAt?: Date;
  includeGitRemote?: boolean;
  includeLocal?: boolean;
  machine?: UsageMachine;
  readGitFile?: ReadGitFile;
  snapshots: UsageSnapshot[];
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
  ...(request.configCwd === undefined ? {} : { configCwd: request.configCwd }),
  ...(request.machine === undefined ? {} : { machine: request.machine }),
  ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
  ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
});

const toHarnessSelection = (
  request: LocalReportRowsRequest,
  cursorCsv: HarnessSelection['cursorCsv'],
): HarnessSelection => ({
  harness: request.harness,
  includeCursor: request.includeCursor,
  ...(request.keepSource === undefined ? {} : { keepSource: request.keepSource }),
  ...(cursorCsv ? { cursorCsv } : {}),
});

const resolveConfigPath = (configCwd: string | undefined, value: string) =>
  configCwd && !path.isAbsolute(value) ? path.resolve(configCwd, value) : value;

const resolveCursorConfig = (
  cursorCsv: HarnessSelection['cursorCsv'],
  configCwd: string | undefined,
): HarnessSelection['cursorCsv'] => {
  if (!cursorCsv) {
    return;
  }
  return {
    ...cursorCsv,
    ...(cursorCsv.usageExportDir ? { usageExportDir: resolveConfigPath(configCwd, cursorCsv.usageExportDir) } : {}),
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
  if (request.harness) {
    return [request.harness];
  }
  if (request.includeCursor) {
    return;
  }
  return harnessKeys.filter((key) => key !== 'cursor');
};

export const collectLocalReportRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const { config, rows } = yield* collectConfiguredLocalRows(request);
    return applyProjectAliases(rows, config.projectAliases ?? []);
  });

export const collectLocalReportRowsWithWarnings = (
  request: LocalReportRowsRequest,
): Effect.Effect<
  LocalReportRowsResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.collectRowsWithWarnings',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const machine = yield* ensureMachineConfig;
      const dbPath = usageStorePath(storage.home);
      const { config, collection } = yield* withPerfSpan(
        'aiUsage.report.collectConfiguredRows',
        collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true }),
        (result) => ({
          harnesses: result.collection.harnesses.length,
          rows: result.collection.rows.length,
          warnings: result.collection.warnings.length,
        }),
      );
      const rows = yield* withPerfSpan(
        'aiUsage.report.applyProjectAliases',
        Effect.sync(() => applyProjectAliases(collection.rows, config.projectAliases ?? [])),
        (aliasedRows) => ({ aliases: config.projectAliases?.length ?? 0, rows: aliasedRows.length }),
      );
      yield* withPerfSpan(
        'aiUsage.usageStore.importLocalRows',
        importLocalRows({ dbPath, machine, rows }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.importLocalRows', dbPath)),
        ),
        (result) => ({
          deleted: result.deleted,
          inserted: result.inserted,
          superseded: result.superseded,
          unchanged: result.unchanged,
          updated: result.updated,
          warnings: result.warnings,
        }),
      );
      const harnessKeys = selectedStoredHarnessKeys(request);
      const stored = yield* withPerfSpan(
        'aiUsage.usageStore.queryReportRows',
        queryReportRows({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)),
        ),
        (result) => ({ rows: result.rows.length }),
      );
      const harnesses = collection.harnesses.map((harness) => ({
        ...harness,
        rows: stored.rows.filter((row) => row.harness === harness.label),
      }));
      return {
        rows: stored.rows,
        warnings: collection.warnings,
        collection: { ...collection, rows: stored.rows, harnesses },
      };
    }),
    (result) => ({
      harnesses: result.collection.harnesses.length,
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

export const createLocalReportPayload = (request: LocalReportPayloadRequest) =>
  withPerfSpan(
    'aiUsage.report.createLocalPayload',
    Effect.gen(function* () {
      const { rows, warnings } = yield* collectLocalReportRowsWithWarnings(request);
      const facets = request.includeFacets
        ? yield* withPerfSpan(
            'aiUsage.report.collectFacets',
            collectHarnessFacets({
              includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
            }),
            (result) => ({ groups: Object.keys(result).length }),
          )
        : undefined;
      const report = yield* withPerfSpan(
        'aiUsage.report.prepare',
        Effect.sync(() => prepareUsageReport(rows, request.options)),
        (prepared) => ({
          omittedRows: prepared.omittedRows,
          rows: prepared.rows.length,
          tableRows: prepared.tableRows.length,
        }),
      );
      return yield* withPerfSpan(
        'aiUsage.report.serializePayload',
        Effect.sync(() =>
          createUsageReportPayload(report, request.options, request.generatedAt ?? new Date(), facets, warnings),
        ),
        (payload) => ({
          rows: payload.rows.length,
          tableRows: payload.tableRows.length,
          warnings: payload.warnings?.length ?? 0,
        }),
      );
    }),
    (payload) => ({
      rows: payload.rows.length,
      tableRows: payload.tableRows.length,
      warnings: payload.warnings?.length ?? 0,
    }),
  );

export const createStoredReportPayload = (
  request: StoredReportPayloadRequest,
): Effect.Effect<
  UsageReportPayload,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.createStoredPayload',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const dbPath = usageStorePath(storage.home);
      const harnessKeys = selectedStoredHarnessKeys(request);
      const stored = yield* withPerfSpan(
        'aiUsage.usageStore.queryStoredReportRows',
        queryReportRows({ dbPath, ...(harnessKeys === undefined ? {} : { harnessKeys }) }).pipe(
          Effect.mapError(usageStoreLocalHistoryError('usageStore.queryReportRows', dbPath)),
        ),
        (result) => ({ rows: result.rows.length }),
      );
      const facets = request.includeFacets
        ? yield* withPerfSpan(
            'aiUsage.report.collectStoredFacets',
            collectHarnessFacets({
              includeCursor: request.includeCursor && (!request.harness || request.harness === 'cursor'),
            }),
            (result) => ({ groups: Object.keys(result).length }),
          )
        : undefined;
      const report = yield* withPerfSpan(
        'aiUsage.report.prepareStored',
        Effect.sync(() => prepareUsageReport(stored.rows, request.options)),
        (prepared) => ({
          omittedRows: prepared.omittedRows,
          rows: prepared.rows.length,
          tableRows: prepared.tableRows.length,
        }),
      );
      return yield* withPerfSpan(
        'aiUsage.report.serializeStoredPayload',
        Effect.sync(() => createUsageReportPayload(report, request.options, request.generatedAt ?? new Date(), facets)),
        (payload) => ({
          rows: payload.rows.length,
          tableRows: payload.tableRows.length,
        }),
      );
    }),
    (payload) => ({
      rows: payload.rows.length,
      tableRows: payload.tableRows.length,
    }),
  );

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
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      ...(request.appVersion === undefined ? {} : { appVersion: request.appVersion }),
      ...(collection.warnings.length ? { warnings: collection.warnings } : {}),
      ...(facets === undefined ? {} : { facets }),
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
      payload: createUsageReportPayload(
        report,
        request.options,
        request.generatedAt ?? new Date(),
        facets,
        payloadWarnings,
      ),
      warnings: allWarnings,
      duplicatesDropped: merged.duplicatesDropped,
    };
  });

const projectFromRow = (row: SourcedRow) => row.project || path.basename(row.source.sourcePath ?? '') || '(unknown)';

const defaultReadGitFile: ReadGitFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

export const parseGitConfigRemote = (text: string, remoteName = 'origin'): string => {
  let inRemote = false;
  for (const line of text.split(GIT_CONFIG_LINE_SEPARATOR)) {
    const remoteMatch = line.match(GIT_REMOTE_HEADER_PATTERN);
    if (remoteMatch) {
      inRemote = remoteMatch[1] === remoteName;
      continue;
    }
    if (GIT_SECTION_HEADER_PATTERN.test(line)) {
      inRemote = false;
      continue;
    }
    if (!inRemote) {
      continue;
    }
    const urlMatch = line.match(GIT_REMOTE_URL_PATTERN);
    if (urlMatch) {
      return extractRepoName(urlMatch[1]!);
    }
  }
  return '';
};

const extractRepoName = (url: string): string => {
  const httpsMatch = url.match(GITHUB_HTTPS_REPO_PATTERN);
  if (httpsMatch) {
    return httpsMatch[1]!;
  }
  const sshMatch = url.match(GITHUB_SSH_REPO_PATTERN);
  if (sshMatch) {
    return sshMatch[1]!;
  }
  return url;
};

const readGitRemoteUrl = (projectPath: string, readGitFile: ReadGitFile): string => {
  const text = readGitFile(path.join(projectPath, '.git', 'config'));
  return text === null ? '' : parseGitConfigRemote(text);
};

const collectProjectSources = (
  rows: SourcedRow[],
  includeGitRemote: boolean,
  readGitFile: ReadGitFile = defaultReadGitFile,
): ProjectSource[] => {
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

  if (includeGitRemote) {
    enrichGitRemotes(result, readGitFile);
  }
  return result;
};

const enrichGitRemotes = (sources: ProjectSource[], readGitFile: ReadGitFile) => {
  const cache = new Map<string, string>();
  for (const source of sources) {
    if (!source.sourcePath) {
      continue;
    }
    const cached = cache.get(source.sourcePath);
    if (cached !== undefined) {
      source.gitRemote = cached;
      continue;
    }
    const gitRemote = readGitRemoteUrl(source.sourcePath, readGitFile);
    cache.set(source.sourcePath, gitRemote);
    source.gitRemote = gitRemote;
  }
};

export const listProjectSourcesWithWarnings = (
  request: ProjectSourcesRequest,
): Effect.Effect<
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
      sources: collectProjectSources(merged.rows, request.includeGitRemote ?? false, request.readGitFile),
      warnings: merged.warnings,
    };
  });

export const listProjectSources = (request: ProjectSourcesRequest) =>
  listProjectSourcesWithWarnings(request).pipe(Effect.map((result) => result.sources));

export const runLocalReportPayload = (request: LocalReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createLocalReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));

export const runStoredReportPayload = (request: StoredReportPayloadRequest): Promise<UsageReportPayload> =>
  Effect.runPromise(createStoredReportPayload(request).pipe(Effect.provide(LocalHistoryStorageLive)));
