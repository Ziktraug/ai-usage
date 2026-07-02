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
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import {
  matchesProjectSourceSelector,
  type ProjectGroupConfig,
  type ProjectGroupingWarning,
  type ProjectSourceSelector,
  projectSourceId,
  projectSourceSelectorLabel,
} from '@ai-usage/report-core/project-group';
import {
  createUsageReportPayload,
  type PreparedUsageReport,
  prepareUsageReport,
  type ReportOptions,
  type UsageReportPayload,
  type UsageReportProjectGroup,
  type UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import { normalizeSessionLineage } from '@ai-usage/report-core/session-lineage';
import {
  createUsageSnapshot,
  mergeUsageSnapshots,
  type SnapshotMergeWarning,
  type UsageMachine,
  type UsageSnapshot,
} from '@ai-usage/report-core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/report-core/types';
import { usageRowLineDelta, usageRowPricedCost, usageRowTokenTotal } from '@ai-usage/report-core/usage-row';
import { importLocalRows, queryReportRows, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { withPerfSpan } from './perf';

const GIT_CONFIG_LINE_SEPARATOR = /\r?\n/;
const GIT_REMOTE_HEADER_PATTERN = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const GIT_SECTION_HEADER_PATTERN = /^\s*\[[^\]]+\]\s*$/;
const GIT_REMOTE_URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/;
const GITHUB_HTTPS_REPO_PATTERN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;
const GITHUB_SSH_REPO_PATTERN = /git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/;
const GITDIR_FILE_PATTERN = /^\s*gitdir:\s*(.+?)\s*$/i;
const CLAUDE_WORKTREE_PATH_SEGMENT = '/.claude/worktrees/';

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
  warnings: UsageReportWarning[];
}

export interface ProjectSource {
  gitRemote: string;
  harness: string;
  harnesses: string[];
  harnessKey: string;
  harnessKeys: string[];
  id: string;
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

interface CanonicalProjectSource {
  project: string;
  sourcePath: string;
}

type CanonicalProjectSourceResolver = (project: string, sourcePath: string) => CanonicalProjectSource;

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

export type ProjectedRow = SourcedRow & {
  projectGroupId: string;
  projectSourceId: string;
  rawProject: string;
};

export interface ProjectedLocalReportRowsResult extends Omit<LocalReportRowsResult, 'rows' | 'warnings'> {
  rows: ProjectedRow[];
  warnings: (LocalHistoryWarning | UsageReportWarning)[];
}

interface ProjectProjection {
  projectGroups: UsageReportProjectGroup[];
  rows: ProjectedRow[];
  warnings: UsageReportWarning[];
}

const prepareNormalizedUsageReport = (rows: Row[], options: ReportOptions) =>
  prepareUsageReport(normalizeSessionLineage(rows), options);

export const collectLocalReportRows = (request: LocalReportRowsRequest) =>
  Effect.gen(function* () {
    const { rows } = yield* collectConfiguredLocalRows(request);
    return rows;
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
      const { collection } = yield* withPerfSpan(
        'aiUsage.report.collectConfiguredRows',
        collectConfiguredLocalRowsWithWarnings({ ...request, keepSource: true }),
        (result) => ({
          harnesses: result.collection.harnesses.length,
          rows: result.collection.rows.length,
          warnings: result.collection.warnings.length,
        }),
      );
      const rows = collection.rows;
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

export const collectProjectedLocalReportRowsWithWarnings = (
  request: LocalReportRowsRequest,
): Effect.Effect<
  ProjectedLocalReportRowsResult,
  LocalHistoryError,
  import('@ai-usage/local-collectors/local-history').LocalHistoryStorage
> =>
  withPerfSpan(
    'aiUsage.report.collectProjectedRowsWithWarnings',
    Effect.gen(function* () {
      const { rows, warnings, collection } = yield* collectLocalReportRowsWithWarnings({
        ...request,
        keepSource: true,
      });
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectGroups',
        Effect.sync(() =>
          buildProjectProjection(rows as SourcedRow[], config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
      return {
        collection,
        rows: projection.rows,
        warnings: [...warnings, ...projection.warnings],
      };
    }),
    (result) => ({
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

export const createLocalReportPayload = (request: LocalReportPayloadRequest) =>
  withPerfSpan(
    'aiUsage.report.createLocalPayload',
    Effect.gen(function* () {
      const { rows, warnings } = yield* collectLocalReportRowsWithWarnings(request);
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectGroups',
        Effect.sync(() =>
          buildProjectProjection(rows as SourcedRow[], config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
      );
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
        Effect.sync(() => prepareNormalizedUsageReport(projection.rows, request.options)),
        (prepared) => ({
          omittedRows: prepared.omittedRows,
          rows: prepared.rows.length,
          tableRows: prepared.tableRows.length,
        }),
      );
      return yield* withPerfSpan(
        'aiUsage.report.serializePayload',
        Effect.sync(() =>
          createUsageReportPayload(
            report,
            request.options,
            request.generatedAt ?? new Date(),
            facets,
            [...warnings, ...projection.warnings],
            projection.projectGroups,
            config.projectGroups ?? [],
          ),
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
      const config = yield* readMergedAiUsageConfigFrom(request.configCwd);
      const projection = yield* withPerfSpan(
        'aiUsage.report.projectStoredGroups',
        Effect.sync(() =>
          buildProjectProjection(stored.rows as SourcedRow[], config.projectGroups ?? [], config.projectAliases ?? []),
        ),
        (result) => ({
          groups: result.projectGroups.length,
          rows: result.rows.length,
          warnings: result.warnings.length,
        }),
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
        Effect.sync(() => prepareNormalizedUsageReport(projection.rows, request.options)),
        (prepared) => ({
          omittedRows: prepared.omittedRows,
          rows: prepared.rows.length,
          tableRows: prepared.tableRows.length,
        }),
      );
      return yield* withPerfSpan(
        'aiUsage.report.serializeStoredPayload',
        Effect.sync(() =>
          createUsageReportPayload(
            report,
            request.options,
            request.generatedAt ?? new Date(),
            facets,
            projection.warnings,
            projection.projectGroups,
            config.projectGroups ?? [],
          ),
        ),
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
    const projection = buildProjectProjection(merged.rows, config.projectGroups ?? [], config.projectAliases ?? []);
    const rows = normalizeSessionLineage(projection.rows);
    const report = prepareUsageReport(rows, request.options);
    const allWarnings = [...merged.warnings, ...projection.warnings];
    const payloadWarnings = allWarnings.map((warning) => {
      if ('key' in warning) {
        const { key, ...payloadWarning } = warning;
        return {
          ...payloadWarning,
          message: key ? `${warning.message}: ${key}` : warning.message,
        };
      }
      return warning;
    });
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
        projection.projectGroups,
        config.projectGroups ?? [],
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

const resolveGitPath = (basePath: string, gitPath: string) =>
  path.isAbsolute(gitPath) ? path.normalize(gitPath) : path.resolve(basePath, gitPath);

const readGitdirFilePath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const gitFilePath = path.join(projectPath, '.git');
  const text = readGitFile(gitFilePath);
  const gitdirMatch = text?.match(GITDIR_FILE_PATTERN);
  if (!gitdirMatch) {
    return null;
  }
  return resolveGitPath(projectPath, gitdirMatch[1]!);
};

const readCommonGitDir = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const gitdirPath = readGitdirFilePath(projectPath, readGitFile);
  if (!gitdirPath) {
    return null;
  }
  const commonDirText = readGitFile(path.join(gitdirPath, 'commondir'));
  if (commonDirText === null) {
    return null;
  }
  return resolveGitPath(gitdirPath, commonDirText.trim());
};

const mainWorktreePathFromCommonGitDir = (commonGitDir: string) =>
  path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : null;

const gitWorktreeParentPath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir === null ? null : mainWorktreePathFromCommonGitDir(commonGitDir);
};

const managedWorktreeParentPath = (projectPath: string): string | null => {
  const normalizedPath = projectPath.replaceAll('\\', '/');
  const markerIndex = normalizedPath.indexOf(CLAUDE_WORKTREE_PATH_SEGMENT);
  return markerIndex > 0 ? normalizedPath.slice(0, markerIndex) : null;
};

const canonicalProjectSource = (project: string, sourcePath: string, readGitFile: ReadGitFile) => {
  if (!sourcePath) {
    return { project, sourcePath };
  }
  const canonicalSourcePath = gitWorktreeParentPath(sourcePath, readGitFile) ?? managedWorktreeParentPath(sourcePath);
  if (!canonicalSourcePath) {
    return { project, sourcePath };
  }
  return {
    project: path.basename(canonicalSourcePath) || project,
    sourcePath: canonicalSourcePath,
  };
};

const createCanonicalProjectSourceResolver = (readGitFile: ReadGitFile): CanonicalProjectSourceResolver => {
  const cache = new Map<string, CanonicalProjectSource>();
  return (project, sourcePath) => {
    const key = [project, sourcePath].join('\0');
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const canonicalSource = canonicalProjectSource(project, sourcePath, readGitFile);
    cache.set(key, canonicalSource);
    return canonicalSource;
  };
};

const readGitRemoteUrl = (projectPath: string, readGitFile: ReadGitFile): string => {
  const text =
    readGitFile(path.join(projectPath, '.git', 'config')) ?? readGitRemoteFromWorktree(projectPath, readGitFile);
  return text === null ? '' : parseGitConfigRemote(text);
};

const readGitRemoteFromWorktree = (projectPath: string, readGitFile: ReadGitFile) => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir === null ? null : readGitFile(path.join(commonGitDir, 'config'));
};

const sourceInputFromRow = (row: SourcedRow, resolveCanonicalProjectSource: CanonicalProjectSourceResolver) => {
  const project = projectFromRow(row);
  return {
    machineId: row.source.machineId ?? '',
    ...resolveCanonicalProjectSource(project, row.source.sourcePath ?? ''),
  };
};

const createProjectSourceFromRow = (
  row: SourcedRow,
  resolveCanonicalProjectSource: CanonicalProjectSourceResolver,
): ProjectSource => {
  const source = sourceInputFromRow(row, resolveCanonicalProjectSource);
  return {
    id: projectSourceId(source),
    project: source.project,
    machine: row.source.machineLabel ?? 'Unknown machine',
    machineId: row.source.machineId ?? '',
    harness: row.harness,
    harnessKey: row.source.harnessKey,
    harnesses: [row.harness],
    harnessKeys: [row.source.harnessKey],
    sourcePath: source.sourcePath,
    gitRemote: '',
    sessions: 0,
    tokens: 0,
  };
};

const collectProjectSources = (
  rows: SourcedRow[],
  includeGitRemote: boolean,
  readGitFile: ReadGitFile = defaultReadGitFile,
  resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(readGitFile),
): ProjectSource[] => {
  const summaries = new Map<string, ProjectSource>();

  for (const row of rows) {
    const summary = createProjectSourceFromRow(row, resolveCanonicalProjectSource);
    const key = summary.id;
    const current = summaries.get(key) ?? summary;
    current.sessions++;
    current.tokens += usageRowTokenTotal(row);
    if (!current.harnesses.includes(row.harness)) {
      current.harnesses.push(row.harness);
      current.harness = current.harnesses.join(', ');
    }
    if (!current.harnessKeys.includes(row.source.harnessKey)) {
      current.harnessKeys.push(row.source.harnessKey);
      current.harnessKey = current.harnessKeys.join(',');
    }
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

const escapeRegex = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const globToRegex = (glob: string) => {
  const normalized = path.normalize(glob).replaceAll(path.sep, '/');
  const pattern = normalized
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
};

const legacyAliasMatchesSource = (source: ProjectSource, alias: ProjectAliasEntry) =>
  alias.match.some((pattern) => {
    const regex = globToRegex(pattern);
    return [source.sourcePath, source.project].some((candidate) => candidate && regex.test(candidate));
  });

const sourceLabel = (source: ProjectSource) =>
  source.machine ? `${source.project} · ${source.machine}` : source.project;

const lineDeltaForRows = (rows: SourcedRow[]) =>
  rows.reduce(
    (total, row) => {
      const lineDelta = usageRowLineDelta(row);
      total.added += lineDelta.added;
      total.deleted += lineDelta.deleted;
      return total;
    },
    { added: 0, deleted: 0 },
  );

const createReportProjectGroup = (
  id: string,
  name: string,
  grouped: boolean,
  sources: ProjectSource[],
  rows: SourcedRow[],
): UsageReportProjectGroup => {
  const lineDelta = lineDeltaForRows(rows);
  return {
    id,
    name,
    grouped,
    sources: sources.map((source) => ({
      gitRemote: source.gitRemote,
      id: source.id,
      machineId: source.machineId,
      machineLabel: source.machine,
      project: source.project,
      sessions: source.sessions,
      sourcePath: source.sourcePath,
      tokens: source.tokens,
    })),
    sessions: rows.length,
    tokens: rows.reduce((total, row) => total + usageRowTokenTotal(row), 0),
    fresh: rows.reduce((total, row) => total + row.tokIn + row.tokOut + row.tokCw, 0),
    cache: rows.reduce((total, row) => total + row.tokCr, 0),
    cost: rows.reduce((total, row) => total + (usageRowPricedCost(row) ?? 0), 0),
    priced: rows.filter((row) => usageRowPricedCost(row) !== null).length,
    linesAdded: lineDelta.added,
    linesDeleted: lineDelta.deleted,
    turns: rows.reduce((total, row) => total + row.turns, 0),
    tools: rows.reduce((total, row) => total + row.tools, 0),
  };
};

const projectGroupingWarning = (
  reason: ProjectGroupingWarning['reason'],
  message: string,
  group?: Pick<ProjectGroupConfig, 'id' | 'name'>,
  selectors?: ProjectSourceSelector[],
): UsageReportWarning => ({
  operation: 'projectGrouping',
  reason,
  message,
  ...(group === undefined ? {} : { groupId: group.id, groupName: group.name }),
  ...(selectors === undefined ? {} : { selectors }),
});

const buildProjectProjection = (
  rows: SourcedRow[],
  groups: ProjectGroupConfig[] = [],
  legacyAliases: ProjectAliasEntry[] = [],
): ProjectProjection => {
  const resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(defaultReadGitFile);
  const sources = collectProjectSources(rows, false, defaultReadGitFile, resolveCanonicalProjectSource);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const rowsBySourceId = new Map<string, SourcedRow[]>();
  for (const row of rows) {
    const sourceId = projectSourceId(sourceInputFromRow(row, resolveCanonicalProjectSource));
    const sourceRows = rowsBySourceId.get(sourceId) ?? [];
    sourceRows.push(row);
    rowsBySourceId.set(sourceId, sourceRows);
  }

  const warnings: UsageReportWarning[] = [];
  const sourceGroupName = new Map<string, { groupId: string; name: string }>();
  const projectGroups: UsageReportProjectGroup[] = [];

  for (const group of groups) {
    const matchedSourceIds = new Set<string>();
    const unmatchedSelectors: ProjectSourceSelector[] = [];
    for (const selector of group.sources) {
      const matched = sources.filter((source) =>
        matchesProjectSourceSelector(
          {
            machineId: source.machineId,
            project: source.project,
            sourcePath: source.sourcePath,
            gitRemote: source.gitRemote,
          },
          selector,
        ),
      );
      if (!matched.length) {
        unmatchedSelectors.push(selector);
        continue;
      }
      if (matched.length > 1) {
        warnings.push(
          projectGroupingWarning(
            'broad-selector',
            `Project group "${group.name}" selector matched ${matched.length} sources: ${projectSourceSelectorLabel(selector)}`,
            group,
          ),
        );
      }
      for (const source of matched) {
        matchedSourceIds.add(source.id);
      }
    }

    if (!matchedSourceIds.size) {
      warnings.push(
        projectGroupingWarning('unmatched-group', `Project group "${group.name}" matches no sources.`, group, [
          ...group.sources,
        ]),
      );
      continue;
    }
    if (unmatchedSelectors.length) {
      const unmatchedLabels = unmatchedSelectors.map(projectSourceSelectorLabel);
      warnings.push(
        projectGroupingWarning(
          'partial-group',
          `Project group "${group.name}" has unmatched selectors: ${unmatchedLabels.join('; ')}`,
          group,
          unmatchedSelectors,
        ),
      );
    }

    const matchedSources = [...matchedSourceIds].flatMap((id) => {
      const source = sourceById.get(id);
      return source ? [source] : [];
    });
    const groupRows = [...matchedSourceIds].flatMap((id) => rowsBySourceId.get(id) ?? []);
    const groupId = `group:${group.id}`;
    projectGroups.push(createReportProjectGroup(groupId, group.name, true, matchedSources, groupRows));
    for (const id of matchedSourceIds) {
      sourceGroupName.set(id, { groupId, name: group.name });
    }
  }

  for (const alias of legacyAliases) {
    const matchedSources = sources.filter(
      (source) => !sourceGroupName.has(source.id) && legacyAliasMatchesSource(source, alias),
    );
    if (!matchedSources.length) {
      continue;
    }
    const groupId = `legacy-alias:${alias.name}`;
    const groupRows = matchedSources.flatMap((source) => rowsBySourceId.get(source.id) ?? []);
    warnings.push(
      projectGroupingWarning(
        'legacy-alias',
        `Legacy project alias "${alias.name}" was applied as a report-time project group.`,
        { id: alias.name, name: alias.name },
      ),
    );
    projectGroups.push(createReportProjectGroup(groupId, alias.name, true, matchedSources, groupRows));
    for (const source of matchedSources) {
      sourceGroupName.set(source.id, { groupId, name: alias.name });
    }
  }

  for (const source of sources) {
    if (sourceGroupName.has(source.id)) {
      continue;
    }
    const groupId = `source:${source.id}`;
    const groupName = sourceLabel(source);
    projectGroups.push(
      createReportProjectGroup(groupId, groupName, false, [source], rowsBySourceId.get(source.id) ?? []),
    );
    sourceGroupName.set(source.id, { groupId, name: groupName });
  }

  const projectedRows = rows.map((row) => {
    const rawProject = row.project;
    const projectSourceIdValue = projectSourceId(sourceInputFromRow(row, resolveCanonicalProjectSource));
    const group = sourceGroupName.get(projectSourceIdValue) ?? {
      groupId: `source:${projectSourceIdValue}`,
      name: projectFromRow(row),
    };
    return {
      ...row,
      rawProject,
      project: group.name,
      projectGroupId: group.groupId,
      projectSourceId: projectSourceIdValue,
    };
  });

  return {
    rows: projectedRows,
    projectGroups: projectGroups.sort((a, b) => b.cost - a.cost || b.fresh - a.fresh),
    warnings,
  };
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
