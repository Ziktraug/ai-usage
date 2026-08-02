import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { parseUsageEngineHandoffId, type UsageEngineFileInput, type UsageEngineHandoffId } from './contracts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_CREATE_FLAGS =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file creation flags are a documented bitmask API.
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface FileFingerprint {
  readonly changedAtMilliseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}

export interface StageUsageEngineHandoffOptions {
  readonly createHandoffId?: () => string;
  readonly inboxDirectory: string;
  readonly maximumBytes?: number;
  readonly signal?: AbortSignal;
}

export interface StagedUsageEngineHandoff {
  readonly cleanup: () => Promise<void>;
  readonly input: Extract<UsageEngineFileInput, { readonly kind: 'inbox-handoff' }>;
}

const fingerprint = (stats: Stats): FileFingerprint => ({
  changedAtMilliseconds: stats.ctimeMs,
  dev: stats.dev,
  ino: stats.ino,
  mode: stats.mode,
  modifiedAtMilliseconds: stats.mtimeMs,
  nlink: stats.nlink,
  size: stats.size,
  uid: stats.uid,
});

const sameFingerprint = (left: FileFingerprint, right: FileFingerprint): boolean =>
  left.changedAtMilliseconds === right.changedAtMilliseconds &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.uid === right.uid;

const currentUserOwns = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

const exactMode = (mode: number, expected: number): boolean =>
  process.platform === 'win32' || mode % 0o1000 === expected;

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const validateInboxDirectory = async (directoryValue: string): Promise<string> => {
  const directory = path.resolve(directoryValue);
  const [stats, canonical] = await Promise.all([
    lstat(directory).catch(() => undefined),
    realpath(directory).catch(() => undefined),
  ]);
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    canonical !== directory ||
    !currentUserOwns(stats.uid) ||
    !exactMode(stats.mode, PRIVATE_DIRECTORY_MODE)
  ) {
    throw new Error('Usage engine inbox directory is unavailable or unsafe.');
  }
  return directory;
};

const assertOpenedHandoff = (stats: Stats, expectedBytes?: number): void => {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    !currentUserOwns(stats.uid) ||
    !exactMode(stats.mode, PRIVATE_FILE_MODE) ||
    (expectedBytes !== undefined && stats.size !== expectedBytes)
  ) {
    throw new Error('Usage engine inbox handoff is unsafe.');
  }
};

const handoffPathFor = (directory: string, handoffId: UsageEngineHandoffId): string => {
  const candidate = path.join(directory, `${handoffId}.upload`);
  if (path.dirname(candidate) !== directory) {
    throw new Error('Usage engine inbox handoff escaped its private directory.');
  }
  return candidate;
};

const removeUnchangedHandoff = async (filePath: string, expected: FileFingerprint): Promise<void> => {
  const current = await lstat(filePath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!current) {
    return;
  }
  const currentFingerprint = fingerprint(current);
  if (!sameFingerprint(currentFingerprint, expected)) {
    throw new Error('Usage engine inbox handoff changed before cleanup and was preserved.');
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) {
      throw error;
    }
  }
};

export const stageUsageEngineHandoff = async (
  bytes: Uint8Array,
  options: StageUsageEngineHandoffOptions,
): Promise<StagedUsageEngineHandoff> => {
  options.signal?.throwIfAborted();
  const maximumBytes = options.maximumBytes ?? MAX_PORTABLE_USAGE_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    bytes.byteLength <= 0 ||
    bytes.byteLength > maximumBytes
  ) {
    throw new Error('Usage engine inbox handoff exceeds its byte limit.');
  }
  const directory = await validateInboxDirectory(options.inboxDirectory);
  options.signal?.throwIfAborted();
  const handoffId = parseUsageEngineHandoffId(options.createHandoffId?.() ?? randomUUID());
  const filePath = handoffPathFor(directory, handoffId);
  const file = await open(filePath, SAFE_CREATE_FLAGS, PRIVATE_FILE_MODE);
  let createdIdentity: Pick<FileFingerprint, 'dev' | 'ino'> | undefined;
  let committed: FileFingerprint | undefined;
  try {
    const opened = await file.stat();
    assertOpenedHandoff(opened, 0);
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    await file.writeFile(bytes, options.signal === undefined ? undefined : { signal: options.signal });
    options.signal?.throwIfAborted();
    await file.sync();
    options.signal?.throwIfAborted();
    const written = await file.stat();
    assertOpenedHandoff(written, bytes.byteLength);
    if (opened.dev !== written.dev || opened.ino !== written.ino) {
      throw new Error('Usage engine inbox handoff changed while it was written.');
    }
    const current = await lstat(filePath);
    const writtenFingerprint = fingerprint(written);
    if (!sameFingerprint(fingerprint(current), writtenFingerprint)) {
      throw new Error('Usage engine inbox handoff changed after it was written.');
    }
    committed = writtenFingerprint;
  } finally {
    await file.close().catch(() => undefined);
    if (!committed && createdIdentity) {
      const created = await lstat(filePath).catch(() => undefined);
      if (
        created?.isFile() &&
        created.dev === createdIdentity.dev &&
        created.ino === createdIdentity.ino &&
        created.nlink === 1 &&
        currentUserOwns(created.uid) &&
        exactMode(created.mode, PRIVATE_FILE_MODE)
      ) {
        await unlink(filePath).catch(() => undefined);
      }
    }
  }
  if (!committed) {
    throw new Error('Usage engine inbox handoff could not be committed.');
  }
  const committedFingerprint = committed;
  let cleaned = false;
  return {
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      await removeUnchangedHandoff(filePath, committedFingerprint);
      cleaned = true;
    },
    input: { handoffId, kind: 'inbox-handoff' },
  };
};
