import { randomUUID } from 'node:crypto';
import fs, { type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  type DeviceCredentialToken,
  parseDeviceCredentialToken,
  revealDeviceCredentialTokenForTransport,
} from './device-tokens';

export const PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION = 1 as const;

const credentialFileName = 'device-credential.json';
const maximumCredentialFileBytes = 512;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const safeReadFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const safeWriteFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

interface FileIdentity {
  readonly changedAtMilliseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}

export interface StoredPrivateDeviceCredential {
  readonly credential: DeviceCredentialToken;
  readonly path: string;
  readonly version: typeof PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorHasCode = (error: unknown, code: string): boolean => isRecord(error) && error.code === code;

const hasCurrentOwner = (uid: number): boolean => process.getuid?.() === undefined || uid === process.getuid();

const hasExactMode = (mode: number, expected: number): boolean =>
  process.platform === 'win32' || mode % 0o1000 === expected;

const identityFrom = (stats: Stats): FileIdentity => ({
  changedAtMilliseconds: stats.ctimeMs,
  dev: stats.dev,
  ino: stats.ino,
  mode: stats.mode,
  modifiedAtMilliseconds: stats.mtimeMs,
  nlink: stats.nlink,
  size: stats.size,
  uid: stats.uid,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.changedAtMilliseconds === right.changedAtMilliseconds &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.uid === right.uid;

const validateDirectory = async (directoryValue: string, create: boolean): Promise<string> => {
  const directory = path.resolve(directoryValue);
  if (create) {
    await mkdir(directory, { mode: privateDirectoryMode, recursive: true });
  }
  const [stats, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !hasCurrentOwner(stats.uid) ||
    !hasExactMode(stats.mode, privateDirectoryMode) ||
    canonical !== directory
  ) {
    throw new Error('The private Device credential directory is unsafe.');
  }
  return directory;
};

const validateCredentialFile = (identity: FileIdentity, expectedBytes?: number): void => {
  if (
    identity.nlink !== 1 ||
    !hasCurrentOwner(identity.uid) ||
    !hasExactMode(identity.mode, privateFileMode) ||
    (expectedBytes === 0 ? identity.size !== 0 : identity.size <= 0) ||
    identity.size > maximumCredentialFileBytes ||
    (expectedBytes !== undefined && identity.size !== expectedBytes)
  ) {
    throw new Error('The private Device credential file is unsafe.');
  }
};

const validateCredentialStats = (stats: Stats, expectedBytes?: number): FileIdentity => {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('The private Device credential file is unsafe.');
  }
  const identity = identityFrom(stats);
  validateCredentialFile(identity, expectedBytes);
  return identity;
};

const parseStoredCredential = (value: unknown, filePath: string): StoredPrivateDeviceCredential => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION ||
    !Object.hasOwn(value, 'credential')
  ) {
    throw new Error('The private Device credential document is invalid.');
  }
  return Object.freeze({
    credential: parseDeviceCredentialToken(value.credential),
    path: filePath,
    version: PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION,
  });
};

export const privateDeviceCredentialPath = (stateDirectory: string): string =>
  path.join(path.resolve(stateDirectory), credentialFileName);

export const loadPrivateDeviceCredential = async (
  stateDirectory: string,
): Promise<StoredPrivateDeviceCredential | null> => {
  const directory = await validateDirectory(stateDirectory, false);
  const filePath = path.join(directory, credentialFileName);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, safeReadFlags);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return null;
    }
    throw new Error('The private Device credential file could not be opened.');
  }
  try {
    const beforeStats = await handle.stat();
    const before = validateCredentialStats(beforeStats);
    const bytes = new Uint8Array(before.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    const [afterStats, currentStats] = await Promise.all([handle.stat(), lstat(filePath)]);
    const after = validateCredentialStats(afterStats);
    const current = validateCredentialStats(currentStats);
    if (read.bytesRead !== bytes.byteLength || !sameIdentity(before, after) || !sameIdentity(before, current)) {
      throw new Error('The private Device credential changed while it was read.');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseStoredCredential(JSON.parse(text) as unknown, filePath);
  } catch {
    throw new Error('The private Device credential file is invalid or unsafe.');
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const storePrivateDeviceCredential = async (
  stateDirectory: string,
  credential: DeviceCredentialToken,
): Promise<StoredPrivateDeviceCredential> => {
  const directory = await validateDirectory(stateDirectory, true);
  const filePath = path.join(directory, credentialFileName);
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (existing) {
    validateCredentialStats(existing);
  }

  const temporaryPath = path.join(directory, `.device-credential-${process.pid}-${randomUUID()}.tmp`);
  const document = `${JSON.stringify({
    credential: revealDeviceCredentialTokenForTransport(credential),
    version: PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION,
  })}\n`;
  const bytes = new TextEncoder().encode(document);
  if (bytes.byteLength > maximumCredentialFileBytes) {
    throw new Error('The private Device credential document is invalid.');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  try {
    handle = await open(temporaryPath, safeWriteFlags, privateFileMode);
    const opened = validateCredentialStats(await handle.stat(), 0);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = validateCredentialStats(await handle.stat(), bytes.byteLength);
    if (opened.dev !== written.dev || opened.ino !== written.ino) {
      throw new Error('The private Device credential changed while it was written.');
    }
    const temporary = validateCredentialStats(await lstat(temporaryPath), bytes.byteLength);
    if (!sameIdentity(written, temporary)) {
      throw new Error('The private Device credential changed before publication.');
    }
    temporaryIdentity = temporary;
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      await chmod(filePath, privateFileMode);
    }
    const published = validateCredentialStats(await lstat(filePath), bytes.byteLength);
    if (published.dev !== temporary.dev || published.ino !== temporary.ino) {
      throw new Error('The private Device credential changed during publication.');
    }
    return Object.freeze({
      credential,
      path: filePath,
      version: PRIVATE_DEVICE_CREDENTIAL_FILE_VERSION,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const currentTemporary = await lstat(temporaryPath).catch(() => undefined);
    if (
      currentTemporary?.isFile() &&
      !currentTemporary.isSymbolicLink() &&
      (!temporaryIdentity ||
        (currentTemporary.dev === temporaryIdentity.dev && currentTemporary.ino === temporaryIdentity.ino))
    ) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw error;
  }
};
