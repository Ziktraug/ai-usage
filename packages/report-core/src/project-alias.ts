import path from 'node:path';
import type { CampaignLabelOverride } from './campaign-label';
import type { ProjectGroupConfig } from './project-group';
import type { SourcePolicyOverrides } from './source-control';
import type { UsageRowWithOptionalSource } from './types';
import type { RoutingConfig } from './work-executors';

export interface ProjectAliasEntry {
  match: string[];
  name: string;
}

/** One `gh` login whose stored token answers pull request reads for one repository owner. */
export interface AiUsageGitHubAccountConfig {
  ghUser: string;
  host: 'github.com';
  owner: string;
}

/**
 * User-home only (ADR 0051). Absent means the pull request source runs through the CLI's active
 * account whenever `gh` is installed; `enabled: false` records a disabled run instead.
 */
export interface AiUsageGitHubConfig {
  accounts?: AiUsageGitHubAccountConfig[];
  enabled?: boolean;
}

/**
 * User-home only (ADR 0054). Absent means the Jira issue source runs through the Atlassian CLI's
 * signed-in session whenever `acli` is installed; `enabled: false` records a disabled run instead.
 * `site` names the Jira site the explicit keys belong to, for the operator's record; this version
 * does not pass it to the CLI.
 */
export interface AiUsageJiraConfig {
  enabled?: boolean;
  site?: string;
}

export interface AiUsageConfig {
  campaignLabelOverrides?: CampaignLabelOverride[];
  cursor?: {
    usageExportPaths?: string[];
    usageExportDir?: string;
    reconcileWindowMs?: number;
    clusterGapMs?: number;
    maxSessionSpanMs?: number;
    user?: string;
  };
  github?: AiUsageGitHubConfig;
  jira?: AiUsageJiraConfig;
  projectAliases?: ProjectAliasEntry[];
  projectGroups?: ProjectGroupConfig[];
  /** Home-only review routing declarations (`routing.executors[]`); entries are parsed by `parseExecutorDeclarations`. */
  routing?: RoutingConfig;
  skills?: unknown;
  sourcePolicies?: SourcePolicyOverrides;
}

const escapeRegex = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const globToRegex = (glob: string) => {
  const normalized = path.normalize(glob).replaceAll(path.sep, '/');
  const pattern = normalized
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
};

const rowProjectCandidates = (row: UsageRowWithOptionalSource) => {
  const sourcePath = row.source?.sourcePath;
  const candidates = [row.project];
  if (sourcePath) {
    const normalized = path.normalize(sourcePath).replaceAll(path.sep, '/');
    candidates.unshift(normalized);
  }
  return candidates.filter(Boolean);
};

const matchesAlias = (row: UsageRowWithOptionalSource, alias: ProjectAliasEntry) => {
  const candidates = rowProjectCandidates(row);
  return alias.match.some((pattern) => {
    const regex = globToRegex(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
};

export const applyProjectAliases = <T extends UsageRowWithOptionalSource>(
  rows: T[],
  aliases: ProjectAliasEntry[] = [],
): T[] => {
  if (!aliases.length) {
    return rows;
  }
  return rows.map((row) => {
    const alias = aliases.find((entry) => entry.name && Array.isArray(entry.match) && matchesAlias(row, entry));
    return alias ? { ...row, project: alias.name } : row;
  });
};
