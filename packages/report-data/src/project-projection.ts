import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import {
  matchesProjectSourceSelector,
  type ProjectGroupConfig,
  type ProjectGroupingWarning,
  type ProjectSourceSelector,
  projectLabelWithMachine,
  projectSourceId,
  projectSourceSelectorLabel,
} from '@ai-usage/report-core/project-group';
import type { UsageReportProjectGroup, UsageReportWarning } from '@ai-usage/report-core/report-data';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { usageRowLineDelta, usageRowPricedCost, usageRowTokenTotal } from '@ai-usage/report-core/usage-row';

const GIT_CONFIG_LINE_SEPARATOR = /\r?\n/;
const GIT_REMOTE_HEADER_PATTERN = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const GIT_SECTION_HEADER_PATTERN = /^\s*\[[^\]]+\]\s*$/;
const GIT_REMOTE_URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/;
const GITHUB_HTTPS_REPO_PATTERN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;
const GITHUB_SSH_REPO_PATTERN = /git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/;
const GITDIR_FILE_PATTERN = /^\s*gitdir:\s*(.+?)\s*$/i;
const CLAUDE_WORKTREE_PATH_SEGMENT = '/.claude/worktrees/';

export type SourceAuthority = 'local-observed' | 'portable-opaque';

export interface AuthorizedSourceRow {
  readonly authority: SourceAuthority;
  readonly row: SourcedRow;
}

export type ProjectedRow = SourcedRow & {
  readonly projectGroupId: string;
  readonly projectSourceId: string;
  readonly rawProject: string;
};

export interface ProjectProjection {
  readonly projectGroups: UsageReportProjectGroup[];
  readonly rows: ProjectedRow[];
  readonly sourceAuthorities: SourceAuthority[];
  readonly warnings: UsageReportWarning[];
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

export type ReadGitFile = (filePath: string) => string | null;

interface CanonicalProjectSource {
  readonly project: string;
  readonly sourcePath: string;
}

type CanonicalProjectSourceResolver = (
  project: string,
  sourcePath: string,
  authority: SourceAuthority,
) => CanonicalProjectSource;

export const authorizeRows = (rows: readonly SourcedRow[], authority: SourceAuthority): AuthorizedSourceRow[] =>
  rows.map((row) => ({ authority, row }));

const projectFromRow = (row: SourcedRow): string =>
  (row as SourcedRow & { readonly rawProject?: string }).rawProject ||
  row.project ||
  path.basename(row.source.sourcePath ?? '') ||
  '(unknown)';

export const defaultReadGitFile: ReadGitFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const extractRepoName = (url: string): string => {
  const httpsMatch = url.match(GITHUB_HTTPS_REPO_PATTERN);
  if (httpsMatch) {
    return httpsMatch[1]!;
  }
  const sshMatch = url.match(GITHUB_SSH_REPO_PATTERN);
  return sshMatch?.[1] ?? url;
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

const resolveGitPath = (basePath: string, gitPath: string): string =>
  path.isAbsolute(gitPath) ? path.normalize(gitPath) : path.resolve(basePath, gitPath);

const readGitdirFilePath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const text = readGitFile(path.join(projectPath, '.git'));
  const gitdirMatch = text?.match(GITDIR_FILE_PATTERN);
  return gitdirMatch ? resolveGitPath(projectPath, gitdirMatch[1]!) : null;
};

const readCommonGitDir = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const gitdirPath = readGitdirFilePath(projectPath, readGitFile);
  if (!gitdirPath) {
    return null;
  }
  const commonDirText = readGitFile(path.join(gitdirPath, 'commondir'));
  return commonDirText === null ? null : resolveGitPath(gitdirPath, commonDirText.trim());
};

const gitWorktreeParentPath = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir !== null && path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : null;
};

const managedWorktreeParentPath = (projectPath: string): string | null => {
  const normalizedPath = projectPath.replaceAll('\\', '/');
  const markerIndex = normalizedPath.indexOf(CLAUDE_WORKTREE_PATH_SEGMENT);
  return markerIndex > 0 ? normalizedPath.slice(0, markerIndex) : null;
};

const canonicalProjectSource = (
  project: string,
  sourcePath: string,
  authority: SourceAuthority,
  readGitFile: ReadGitFile,
): CanonicalProjectSource => {
  if (!sourcePath || authority === 'portable-opaque') {
    return { project, sourcePath };
  }
  const canonicalSourcePath = gitWorktreeParentPath(sourcePath, readGitFile) ?? managedWorktreeParentPath(sourcePath);
  return canonicalSourcePath
    ? { project: path.basename(canonicalSourcePath) || project, sourcePath: canonicalSourcePath }
    : { project, sourcePath };
};

const createCanonicalProjectSourceResolver = (readGitFile: ReadGitFile): CanonicalProjectSourceResolver => {
  const cache = new Map<string, CanonicalProjectSource>();
  return (project, sourcePath, authority) => {
    const key = [project, sourcePath, authority].join('\0');
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const canonicalSource = canonicalProjectSource(project, sourcePath, authority, readGitFile);
    cache.set(key, canonicalSource);
    return canonicalSource;
  };
};

const readGitRemoteFromWorktree = (projectPath: string, readGitFile: ReadGitFile): string | null => {
  const commonGitDir = readCommonGitDir(projectPath, readGitFile);
  return commonGitDir === null ? null : readGitFile(path.join(commonGitDir, 'config'));
};

const readGitRemoteUrl = (projectPath: string, readGitFile: ReadGitFile): string => {
  const text =
    readGitFile(path.join(projectPath, '.git', 'config')) ?? readGitRemoteFromWorktree(projectPath, readGitFile);
  return text === null ? '' : parseGitConfigRemote(text);
};

const sourceInputFromRow = (
  row: SourcedRow,
  authority: SourceAuthority,
  resolveCanonicalProjectSource: CanonicalProjectSourceResolver,
) => ({
  machineId: row.source.machineId ?? '',
  ...resolveCanonicalProjectSource(projectFromRow(row), row.source.sourcePath ?? '', authority),
});

const createProjectSourceFromRow = (
  row: SourcedRow,
  authority: SourceAuthority,
  resolveCanonicalProjectSource: CanonicalProjectSourceResolver,
): ProjectSource => {
  const source = sourceInputFromRow(row, authority, resolveCanonicalProjectSource);
  return {
    gitRemote: '',
    harness: row.harness,
    harnesses: [row.harness],
    harnessKey: row.source.harnessKey,
    harnessKeys: [row.source.harnessKey],
    id: projectSourceId(source),
    machine: row.source.machineLabel ?? 'Unknown machine',
    machineId: row.source.machineId ?? '',
    project: source.project,
    sessions: 0,
    sourcePath: source.sourcePath,
    tokens: 0,
  };
};

export const collectProjectSources = (
  candidates: readonly AuthorizedSourceRow[],
  includeGitRemote: boolean,
  readGitFile: ReadGitFile = defaultReadGitFile,
  resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(readGitFile),
): ProjectSource[] => {
  const summaries = new Map<string, ProjectSource>();
  for (const { authority, row } of candidates) {
    const summary = createProjectSourceFromRow(row, authority, resolveCanonicalProjectSource);
    const current = summaries.get(summary.id) ?? summary;
    current.sessions += 1;
    current.tokens += usageRowTokenTotal(row);
    if (!current.harnesses.includes(row.harness)) {
      current.harnesses.push(row.harness);
      current.harness = current.harnesses.join(', ');
    }
    if (!current.harnessKeys.includes(row.source.harnessKey)) {
      current.harnessKeys.push(row.source.harnessKey);
      current.harnessKey = current.harnessKeys.join(',');
    }
    if (includeGitRemote && authority === 'local-observed' && !current.gitRemote && current.sourcePath) {
      current.gitRemote = readGitRemoteUrl(current.sourcePath, readGitFile);
    }
    summaries.set(summary.id, current);
  }
  return [...summaries.values()].sort(
    (left, right) =>
      left.project.localeCompare(right.project) ||
      left.machine.localeCompare(right.machine) ||
      left.harness.localeCompare(right.harness),
  );
};

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const globToRegex = (glob: string): RegExp => {
  const normalized = path.normalize(glob).replaceAll(path.sep, '/');
  const pattern = normalized
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
};

const legacyAliasMatchesSource = (source: ProjectSource, alias: ProjectAliasEntry): boolean =>
  alias.match.some((pattern) => {
    const regex = globToRegex(pattern);
    return [source.sourcePath, source.project].some((candidate) => candidate.length > 0 && regex.test(candidate));
  });

const lineDeltaForRows = (rows: readonly SourcedRow[]) =>
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
  sources: readonly ProjectSource[],
  rows: readonly SourcedRow[],
): UsageReportProjectGroup => {
  const lineDelta = lineDeltaForRows(rows);
  return {
    cache: rows.reduce((total, row) => total + row.tokCr, 0),
    cost: rows.reduce((total, row) => total + (usageRowPricedCost(row) ?? 0), 0),
    fresh: rows.reduce((total, row) => total + row.tokIn + row.tokOut + row.tokCw, 0),
    grouped,
    id,
    linesAdded: lineDelta.added,
    linesDeleted: lineDelta.deleted,
    name,
    priced: rows.filter((row) => usageRowPricedCost(row) !== null).length,
    sessions: rows.length,
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
    tokens: rows.reduce((total, row) => total + usageRowTokenTotal(row), 0),
    tools: rows.reduce((total, row) => total + row.tools, 0),
    turns: rows.reduce((total, row) => total + row.turns, 0),
  };
};

const projectGroupingWarning = (
  reason: ProjectGroupingWarning['reason'],
  message: string,
  group?: Pick<ProjectGroupConfig, 'id' | 'name'>,
  selectors?: readonly ProjectSourceSelector[],
): UsageReportWarning => ({
  message,
  operation: 'projectGrouping',
  reason,
  ...(group === undefined ? {} : { groupId: group.id, groupName: group.name }),
  ...(selectors === undefined ? {} : { selectors: [...selectors] }),
});

export const buildProjectProjection = (
  candidates: readonly AuthorizedSourceRow[],
  groups: readonly ProjectGroupConfig[] = [],
  legacyAliases: readonly ProjectAliasEntry[] = [],
): ProjectProjection => {
  const resolveCanonicalProjectSource = createCanonicalProjectSourceResolver(defaultReadGitFile);
  const sources = collectProjectSources(candidates, false, defaultReadGitFile, resolveCanonicalProjectSource);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const rowsBySourceId = new Map<string, SourcedRow[]>();
  for (const { authority, row } of candidates) {
    const sourceId = projectSourceId(sourceInputFromRow(row, authority, resolveCanonicalProjectSource));
    const sourceRows = rowsBySourceId.get(sourceId) ?? [];
    sourceRows.push(row);
    rowsBySourceId.set(sourceId, sourceRows);
  }

  const warnings: UsageReportWarning[] = [];
  const sourceGroupName = new Map<string, { readonly groupId: string; readonly name: string }>();
  const projectGroups: UsageReportProjectGroup[] = [];
  for (const group of groups) {
    const matchedSourceIds = new Set<string>();
    const unmatchedSelectors: ProjectSourceSelector[] = [];
    for (const selector of group.sources) {
      const matched = sources.filter((source) =>
        matchesProjectSourceSelector(
          {
            gitRemote: source.gitRemote,
            machineId: source.machineId,
            project: source.project,
            sourcePath: source.sourcePath,
          },
          selector,
        ),
      );
      if (matched.length === 0) {
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

    if (matchedSourceIds.size === 0) {
      warnings.push(
        projectGroupingWarning(
          'unmatched-group',
          `Project group "${group.name}" matches no sources.`,
          group,
          group.sources,
        ),
      );
      continue;
    }
    if (unmatchedSelectors.length > 0) {
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
    if (matchedSources.length === 0) {
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
    const groupName = projectLabelWithMachine(source.project, source.machine);
    projectGroups.push(
      createReportProjectGroup(groupId, groupName, false, [source], rowsBySourceId.get(source.id) ?? []),
    );
    sourceGroupName.set(source.id, { groupId, name: groupName });
  }

  return {
    projectGroups: projectGroups.sort((left, right) => right.cost - left.cost || right.fresh - left.fresh),
    rows: candidates.map(({ authority, row }) => {
      const rawProject = row.project;
      const projectSourceIdValue = projectSourceId(sourceInputFromRow(row, authority, resolveCanonicalProjectSource));
      const group = sourceGroupName.get(projectSourceIdValue) ?? {
        groupId: `source:${projectSourceIdValue}`,
        name: projectFromRow(row),
      };
      return {
        ...row,
        project: group.name,
        projectGroupId: group.groupId,
        projectSourceId: projectSourceIdValue,
        rawProject,
      };
    }),
    sourceAuthorities: candidates.map(({ authority }) => authority),
    warnings,
  };
};
