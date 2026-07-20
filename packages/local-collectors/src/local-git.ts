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
