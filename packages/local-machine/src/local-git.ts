import fs from 'node:fs';
import path from 'node:path';
import { normalizeSessionVcsRepository, type SessionVcsRepository } from '@ai-usage/report-core/session-vcs';
import { readRegularFileText } from './local-history';

const MAX_GIT_CONFIG_BYTES = 64 * 1024;
const MAX_REPOSITORY_SEARCH_DEPTH = 32;
const REMOTE_SECTION = /^\s*\[remote\s+"([^"]+)"\]\s*$/;
const CONFIG_ENTRY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/;
const LINE_SEPARATOR = /\r?\n/;

const originRemoteFromConfig = (text: string): string | null => {
  let section: string | null = null;
  for (const line of text.split(LINE_SEPARATOR)) {
    const remote = REMOTE_SECTION.exec(line);
    if (remote) {
      section = remote[1] ?? null;
      continue;
    }
    if (line.trimStart().startsWith('[')) {
      section = null;
      continue;
    }
    const entry = CONFIG_ENTRY.exec(line);
    if (section === 'origin' && entry?.[1]?.toLowerCase() === 'url') {
      return entry[2] ?? null;
    }
  }
  return null;
};

/** The nearest enclosing `.git` directory: a worktree's or submodule's `.git` file is skipped. */
const enclosingGitDirectory = (sourcePath: string): string | null => {
  if (!(path.isAbsolute(sourcePath) && !sourcePath.includes('\0'))) {
    return null;
  }
  let current = path.resolve(sourcePath);
  for (let depth = 0; depth <= MAX_REPOSITORY_SEARCH_DEPTH; depth += 1) {
    const gitPath = path.join(current, '.git');
    try {
      const gitStat = fs.lstatSync(gitPath);
      if (gitStat.isDirectory() && !gitStat.isSymbolicLink()) {
        return gitPath;
      }
    } catch {
      // Missing or unsafe repository metadata is absence.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
};

const ORIGIN_HEAD = /^ref: refs\/remotes\/origin\/(.+?)\s*$/;

/** The default branch the clone's `origin` names (`refs/remotes/origin/HEAD`), when recorded. */
export const readLocalDefaultBranch = (sourcePath: string): string | null => {
  const gitPath = enclosingGitDirectory(sourcePath);
  if (gitPath === null) {
    return null;
  }
  try {
    return (
      ORIGIN_HEAD.exec(readRegularFileText(path.join(gitPath, 'refs', 'remotes', 'origin', 'HEAD'), 1024))?.[1] ?? null
    );
  } catch {
    return null;
  }
};

const SSH_CONFIG_ENTRY = /^\s*(\S+)\s*=?\s*(.*?)\s*$/;
const WHITESPACE = /\s+/;
const HOST_PATTERN_CHARACTER = /[*?!]/;
const MAX_SSH_CONFIG_BYTES = 256 * 1024;

/**
 * `Host` names of `~/.ssh/config` that set a different `HostName`: what git connects to for a remote
 * written with the alias. Patterns (`*`, `?`, `!`) and `Match` blocks name no single host and are
 * skipped; included files are not followed.
 */
export const readSshHostAliases = (home: string): Record<string, string> => {
  let text: string;
  try {
    text = readRegularFileText(path.join(home, '.ssh', 'config'), MAX_SSH_CONFIG_BYTES);
  } catch {
    return {};
  }
  const aliases: Record<string, string> = {};
  let hosts: string[] = [];
  for (const line of text.split(LINE_SEPARATOR)) {
    if (line.trimStart().startsWith('#')) {
      continue;
    }
    const entry = SSH_CONFIG_ENTRY.exec(line);
    const keyword = entry?.[1]?.toLowerCase();
    const value = entry?.[2] ?? '';
    if (keyword === 'host') {
      hosts = value.split(WHITESPACE).filter((host) => host && !HOST_PATTERN_CHARACTER.test(host));
    } else if (keyword === 'match') {
      hosts = [];
    } else if (keyword === 'hostname' && value) {
      for (const host of hosts) {
        const alias = host.toLowerCase();
        if (alias !== value.toLowerCase() && !(alias in aliases)) {
          aliases[alias] = value.toLowerCase();
        }
      }
    }
  }
  return aliases;
};

export const readLocalGitRepository = (sourcePath: string | null): SessionVcsRepository | null => {
  if (!(sourcePath && path.isAbsolute(sourcePath) && !sourcePath.includes('\0'))) {
    return null;
  }
  let current = path.resolve(sourcePath);
  for (let depth = 0; depth <= MAX_REPOSITORY_SEARCH_DEPTH; depth += 1) {
    const gitPath = path.join(current, '.git');
    try {
      const gitStat = fs.lstatSync(gitPath);
      if (gitStat.isDirectory() && !gitStat.isSymbolicLink()) {
        const config = readRegularFileText(path.join(gitPath, 'config'), MAX_GIT_CONFIG_BYTES);
        const remote = originRemoteFromConfig(config);
        return remote ? normalizeSessionVcsRepository(remote, 'local-derived') : null;
      }
    } catch {
      // Missing or unsafe repository metadata is absence, never session failure.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
};
