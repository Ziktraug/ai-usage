import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParityShard } from './schema';

const shardFilePattern = /\.parity\.ts$/u;

export interface LoadedParityShard {
  file: string;
  shard: unknown;
}

interface ParityShardModule {
  default?: unknown;
  shard?: unknown;
}

export const parityShardDirectory = (repositoryRoot: string): string =>
  path.join(repositoryRoot, 'apps', 'web', 'migration-parity', 'shards');

export const loadParityShards = async (
  repositoryRoot: string,
  directory = parityShardDirectory(repositoryRoot),
): Promise<readonly LoadedParityShard[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && shardFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const loaded: LoadedParityShard[] = [];

  for (const file of files) {
    const absoluteFile = path.join(directory, file);
    const module = (await import(pathToFileURL(absoluteFile).href)) as ParityShardModule;
    loaded.push({ file, shard: module.default ?? module.shard });
  }

  return loaded;
};

export const asParityShard = (value: unknown): ParityShard | undefined => {
  if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
    return;
  }
  const candidate = value as Record<string, unknown>;
  if (!(typeof candidate.owner === 'string' && Array.isArray(candidate.records))) {
    return;
  }
  return value as ParityShard;
};
