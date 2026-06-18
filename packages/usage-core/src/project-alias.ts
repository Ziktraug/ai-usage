import path from 'node:path';
import type { Row, SourcedRow } from './types';

export interface ProjectAliasEntry {
  name: string;
  match: string[];
}

export interface AiUsageConfig {
  projectAliases?: ProjectAliasEntry[];
  cursor?: {
    usageExportPaths?: string[];
    usageExportDir?: string;
    reconcileWindowMs?: number;
    clusterGapMs?: number;
    maxSessionSpanMs?: number;
    user?: string;
  };
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

const rowProjectCandidates = (row: Row) => {
  const sourcePath = (row as Partial<SourcedRow>).source?.sourcePath;
  const candidates = [row.project];
  if (sourcePath) {
    const normalized = path.normalize(sourcePath).replaceAll(path.sep, '/');
    candidates.unshift(normalized);
  }
  return candidates.filter(Boolean);
};

const matchesAlias = (row: Row, alias: ProjectAliasEntry) => {
  const candidates = rowProjectCandidates(row);
  return alias.match.some((pattern) => {
    const regex = globToRegex(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
};

export const applyProjectAliases = (rows: Row[], aliases: ProjectAliasEntry[] = []): Row[] => {
  if (!aliases.length) return rows;
  return rows.map((row) => {
    const alias = aliases.find((entry) => entry.name && Array.isArray(entry.match) && matchesAlias(row, entry));
    return alias ? { ...row, project: alias.name } : row;
  });
};
