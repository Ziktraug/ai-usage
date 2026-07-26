import type { Stats } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const createNewFileFlags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;

interface PrivateStorePathIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface PrivateStoreConfirmationIdentity {
  readonly database: PrivateStorePathIdentity;
  readonly directory: PrivateStorePathIdentity;
}

const pathIdentity = (stat: Stats): PrivateStorePathIdentity => ({
  device: stat.dev,
  inode: stat.ino,
});

const assertOwnerOnly = (stat: Stats, candidate: string, expectedMode: number): void => {
  if (process.platform === 'win32') {
    return;
  }
  const currentUserId = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (currentUserId !== undefined && stat.uid !== currentUserId) {
    throw new Error(`usage-store path is not owned by the current user: ${candidate}`);
  }
  if (stat.mode % 0o1_0000 !== expectedMode) {
    throw new Error(`usage-store path is not owner-only: ${candidate}`);
  }
};

export const inspectPrivateStoreForConfirmation = (filePath: string): PrivateStoreConfirmationIdentity => {
  const directory = path.dirname(filePath);
  const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!(directoryStat?.isDirectory() && !directoryStat.isSymbolicLink())) {
    throw new Error(`usage-store directory is unsafe for confirmation: ${directory}`);
  }
  assertOwnerOnly(directoryStat, directory, privateDirectoryMode);

  let databaseIdentity: PrivateStorePathIdentity | undefined;
  for (const [candidate, required] of [
    [filePath, true],
    [`${filePath}-wal`, false],
    [`${filePath}-shm`, false],
  ] as const) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) {
      if (required) {
        throw new Error('usage-store database is unavailable for confirmation');
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error(`usage-store file is unsafe for confirmation: ${candidate}`);
    }
    assertOwnerOnly(stat, candidate, privateFileMode);
    if (candidate === filePath) {
      databaseIdentity = pathIdentity(stat);
    }
  }
  if (!databaseIdentity) {
    throw new Error('usage-store database is unavailable for confirmation');
  }
  return { database: databaseIdentity, directory: pathIdentity(directoryStat) };
};

export const revalidatePrivateStoreForConfirmation = (
  filePath: string,
  expected: PrivateStoreConfirmationIdentity,
): void => {
  const current = inspectPrivateStoreForConfirmation(filePath);
  if (process.platform === 'win32') {
    return;
  }
  // Device/inode checks narrow accidental replacement around open/BEGIN. The token binds semantic state, not
  // filesystem identity, and this does not claim protection from a hostile same-UID actor performing an ABA swap.
  if (
    current.directory.device !== expected.directory.device ||
    current.directory.inode !== expected.directory.inode ||
    current.database.device !== expected.database.device ||
    current.database.inode !== expected.database.inode
  ) {
    throw new Error('usage-store identity changed during confirmation');
  }
};

export const preparePrivateStoreFile = (filePath: string): void => {
  const directory = path.dirname(filePath);
  const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory())) {
    throw new Error(`usage-store directory is unsafe: ${directory}`);
  }
  fs.mkdirSync(directory, { mode: privateDirectoryMode, recursive: true });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, privateDirectoryMode);
  }
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error(`usage-store file is unsafe: ${candidate}`);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(candidate, privateFileMode);
    }
  }
  if (!fs.existsSync(filePath)) {
    fs.closeSync(fs.openSync(filePath, createNewFileFlags, privateFileMode));
  }
};
