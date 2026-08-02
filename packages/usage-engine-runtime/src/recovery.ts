import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readOpenedFileBounded } from '@ai-usage/usage-engine-control/node';

const LEGACY_ARTIFACT_PREFIXES = ['ai-usage-report-revisions-', 'ai-usage-session-query-lease-'] as const;
const LEGACY_MKDTEMP_SUFFIX_PATTERN = /^[A-Za-z0-9]{6}$/;
const OWNER_FILE_NAME = '.owner.json';
const MAX_OWNER_BYTES = 1024;
const MAX_SCAVENGE_ENTRIES = 100_000;
const MAX_SCAVENGE_ROOT_ENTRIES = 10_000;
const PROCESS_START_TIME_INDEX = 19;
const DIGITS_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s+/;
const SHARED_TEMP_ROOT_MODE = 0o1002;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OwnerMetadata {
  readonly pid: number;
  readonly processStartTimeTicks: string | null;
}

interface InspectedTree {
  readonly bytes: number;
  readonly entries: number;
  readonly identity: FileIdentity;
  readonly liveOwner: boolean;
  readonly safe: boolean;
}

export interface LegacyArtifactScavengeOptions {
  readonly gracePeriodMs: number;
  readonly maximumRootEntries?: number;
  readonly now?: number;
  readonly temporaryRoot: string;
}

export interface LegacyArtifactScavengeResult {
  readonly deletedBytes: number;
  readonly deletedEntries: number;
  readonly deletedRoots: number;
  readonly skippedSuspicious: number;
}

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const hasCurrentOwner = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

const isOwnerOnly = (mode: number): boolean => process.platform === 'win32' || mode % 0o100 === 0;

export const isTrustedUsageEngineTemporaryRoot = (
  stats: { readonly mode: number; readonly uid: number },
  currentUserId: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined,
): boolean => {
  if (currentUserId === undefined) {
    return true;
  }
  if (stats.uid === currentUserId) {
    return isOwnerOnly(stats.mode);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix sticky/world-write permissions are a mode bitmask.
  return (stats.mode & SHARED_TEMP_ROOT_MODE) === SHARED_TEMP_ROOT_MODE;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
};

const processStartTimeTicks = async (pid: number): Promise<string | null> => {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
      return null;
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(WHITESPACE_PATTERN);
    const startTime = fields[PROCESS_START_TIME_INDEX];
    return startTime && DIGITS_PATTERN.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
};

const parseOwnerMetadata = (value: unknown): OwnerMetadata | undefined => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'pid,processStartTimeTicks'
  ) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    !(
      typeof record.pid === 'number' &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      (record.processStartTimeTicks === null ||
        (typeof record.processStartTimeTicks === 'string' && DIGITS_PATTERN.test(record.processStartTimeTicks)))
    )
  ) {
    return;
  }
  return { pid: record.pid, processStartTimeTicks: record.processStartTimeTicks };
};

const readOwnerMetadata = async (ownerPath: string): Promise<OwnerMetadata | undefined> => {
  let ownerFile: Awaited<ReturnType<typeof open>>;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
    ownerFile = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return;
  }
  try {
    const stats = await ownerFile.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      !hasCurrentOwner(stats.uid) ||
      !isOwnerOnly(stats.mode) ||
      stats.size <= 0 ||
      stats.size > MAX_OWNER_BYTES
    ) {
      return;
    }
    try {
      const bytes = await readOpenedFileBounded(ownerFile, stats.size);
      const after = await ownerFile.stat();
      if (
        bytes.byteLength !== stats.size ||
        !sameIdentity(stats, after) ||
        after.size !== stats.size ||
        after.nlink !== 1 ||
        !hasCurrentOwner(after.uid) ||
        !isOwnerOnly(after.mode)
      ) {
        return;
      }
      return parseOwnerMetadata(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch {
      return;
    }
  } finally {
    await ownerFile.close().catch(() => undefined);
  }
};

const ownerIsLive = async (metadata: OwnerMetadata): Promise<boolean> => {
  if (!processIsAlive(metadata.pid)) {
    return false;
  }
  const currentStartTime = await processStartTimeTicks(metadata.pid);
  return (
    metadata.processStartTimeTicks === null ||
    currentStartTime === null ||
    metadata.processStartTimeTicks === currentStartTime
  );
};

const inspectTree = async (rootPath: string): Promise<InspectedTree> => {
  const rootStats = await lstat(rootPath).catch(() => undefined);
  if (
    !rootStats ||
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !hasCurrentOwner(rootStats.uid) ||
    !isOwnerOnly(rootStats.mode) ||
    (await realpath(rootPath).catch(() => undefined)) !== rootPath
  ) {
    return { bytes: 0, entries: 0, identity: rootStats ?? { dev: -1, ino: -1 }, liveOwner: false, safe: false };
  }
  const pending = [rootPath];
  let bytes = 0;
  let entries = 1;
  let ownerMetadata: OwnerMetadata | undefined;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    const children = await opendir(directory).catch(() => undefined);
    if (!children) {
      return { bytes, entries, identity: rootStats, liveOwner: false, safe: false };
    }
    for await (const child of children) {
      entries += 1;
      if (entries > MAX_SCAVENGE_ENTRIES) {
        return { bytes, entries, identity: rootStats, liveOwner: false, safe: false };
      }
      const childPath = path.join(directory, child.name);
      const stats = await lstat(childPath).catch(() => undefined);
      if (!stats || stats.isSymbolicLink() || !hasCurrentOwner(stats.uid) || !isOwnerOnly(stats.mode)) {
        return { bytes, entries, identity: rootStats, liveOwner: false, safe: false };
      }
      if (stats.isDirectory()) {
        pending.push(childPath);
        continue;
      }
      if (!(stats.isFile() && stats.nlink === 1)) {
        return { bytes, entries, identity: rootStats, liveOwner: false, safe: false };
      }
      bytes += stats.size;
      if (!Number.isSafeInteger(bytes)) {
        return { bytes: 0, entries, identity: rootStats, liveOwner: false, safe: false };
      }
      if (directory === rootPath && child.name === OWNER_FILE_NAME) {
        ownerMetadata = await readOwnerMetadata(childPath);
        if (!ownerMetadata) {
          return { bytes, entries, identity: rootStats, liveOwner: false, safe: false };
        }
      }
    }
  }
  return {
    bytes,
    entries,
    identity: rootStats,
    liveOwner: ownerMetadata ? await ownerIsLive(ownerMetadata) : false,
    safe: true,
  };
};

const legacyArtifactPrefixFor = (name: string): (typeof LEGACY_ARTIFACT_PREFIXES)[number] | undefined =>
  LEGACY_ARTIFACT_PREFIXES.find((prefix) => name.startsWith(prefix));

const isLegacyArtifactName = (name: string, prefix: (typeof LEGACY_ARTIFACT_PREFIXES)[number]): boolean =>
  LEGACY_MKDTEMP_SUFFIX_PATTERN.test(name.slice(prefix.length));

const canonicalTemporaryRoot = async (temporaryRootValue: string): Promise<string> => {
  const temporaryRoot = path.resolve(temporaryRootValue);
  const stats = await lstat(temporaryRoot).catch(() => undefined);
  if (
    !stats ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isTrustedUsageEngineTemporaryRoot(stats) ||
    (await realpath(temporaryRoot).catch(() => undefined)) !== temporaryRoot
  ) {
    throw new Error('Usage engine temporary root must be a canonical owned directory.');
  }
  return temporaryRoot;
};

export const scavengeLegacyUsageEngineArtifacts = async ({
  gracePeriodMs,
  maximumRootEntries = MAX_SCAVENGE_ROOT_ENTRIES,
  now = Date.now(),
  temporaryRoot: temporaryRootValue,
}: LegacyArtifactScavengeOptions): Promise<LegacyArtifactScavengeResult> => {
  if (
    !(
      Number.isSafeInteger(now) &&
      now >= 0 &&
      Number.isSafeInteger(gracePeriodMs) &&
      gracePeriodMs > 0 &&
      gracePeriodMs <= now &&
      Number.isSafeInteger(maximumRootEntries) &&
      maximumRootEntries > 0 &&
      maximumRootEntries <= MAX_SCAVENGE_ROOT_ENTRIES
    )
  ) {
    throw new Error('Usage engine legacy artifact recovery timing is invalid.');
  }
  const temporaryRoot = await canonicalTemporaryRoot(temporaryRootValue);
  const entries = await opendir(temporaryRoot);
  let deletedBytes = 0;
  let deletedEntries = 0;
  let deletedRoots = 0;
  let skippedSuspicious = 0;
  let rootEntryCount = 0;
  for await (const entry of entries) {
    rootEntryCount++;
    if (rootEntryCount > maximumRootEntries) {
      skippedSuspicious += 1;
      break;
    }
    const legacyPrefix = legacyArtifactPrefixFor(entry.name);
    if (!legacyPrefix) {
      continue;
    }
    if (!isLegacyArtifactName(entry.name, legacyPrefix)) {
      skippedSuspicious += 1;
      continue;
    }
    const candidatePath = path.join(temporaryRoot, entry.name);
    const candidateStats = await lstat(candidatePath).catch(() => undefined);
    if (!candidateStats || candidateStats.mtimeMs > now - gracePeriodMs) {
      continue;
    }
    const inspection = await inspectTree(candidatePath);
    if (!(inspection.safe && !inspection.liveOwner)) {
      skippedSuspicious += 1;
      continue;
    }
    const current = await lstat(candidatePath).catch(() => undefined);
    if (!(current?.isDirectory() && sameIdentity(current, inspection.identity))) {
      skippedSuspicious += 1;
      continue;
    }
    const quarantinePath = path.join(temporaryRoot, `.ai-usage-scavenge-${process.pid}-${randomUUID()}`);
    try {
      await rename(candidatePath, quarantinePath);
      const quarantined = await lstat(quarantinePath);
      if (!sameIdentity(quarantined, inspection.identity)) {
        throw new Error('Legacy artifact identity changed during quarantine.');
      }
      const reinspection = await inspectTree(quarantinePath);
      if (!(reinspection.safe && !reinspection.liveOwner && sameIdentity(reinspection.identity, inspection.identity))) {
        throw new Error('Legacy artifact changed during recovery validation.');
      }
      await rm(quarantinePath, { recursive: true });
      deletedBytes += reinspection.bytes;
      deletedEntries += reinspection.entries;
      deletedRoots += 1;
    } catch {
      const originalExists = await lstat(candidatePath).catch(() => undefined);
      const quarantineExists = await lstat(quarantinePath).catch(() => undefined);
      if (!originalExists && quarantineExists && sameIdentity(quarantineExists, inspection.identity)) {
        await rename(quarantinePath, candidatePath).catch(() => undefined);
      }
      skippedSuspicious += 1;
    }
  }
  return { deletedBytes, deletedEntries, deletedRoots, skippedSuspicious };
};
